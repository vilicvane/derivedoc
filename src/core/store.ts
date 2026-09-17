import fs from 'node:fs/promises';
import path from 'node:path';

import {watch, type FSWatcher} from 'chokidar';

import {DocStoreError} from './errors.ts';
import {parseDoc, resolveTitle} from './frontmatter.ts';
import {extractLinkIds} from './links.ts';
import {idOfPath, kindOfId, normalizeId, pathOfId} from './paths.ts';
import {computeRevision} from './revision.ts';
import type {Doc, DocChange, DocKind, DocMeta} from './types.ts';

const IGNORED = /(^|[/\\])(\.derivedoc|node_modules|\.git)([/\\]|$)/;

const SNIPPET_RADIUS = 40;

function snippetOf(body: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(body.length, index + length + SNIPPET_RADIUS);
  const text = body.slice(start, end).replace(/\s+/g, ' ').trim();

  return `${start > 0 ? '…' : ''}${text}${end < body.length ? '…' : ''}`;
}

export interface WriteOptions {
  /** 期望的当前修订号；不匹配则冲突。省略表示不做并发校验。 */
  baseRevision?: string;
}

export interface ListOptions {
  kind?: DocKind;
}

export interface SearchHit extends DocMeta {
  snippet: string;
}

export class DocStore {
  readonly root: string;

  #index = new Map<string, Doc>();
  #listeners = new Set<(change: DocChange) => void>();
  #watcher?: FSWatcher;
  #closed = false;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string, options: {watch?: boolean} = {}): Promise<DocStore> {
    const store = new DocStore(path.resolve(root));
    await store.scan();

    if (options.watch !== false) {
      store.#startWatching();
      await store.#whenReady();
    }

    return store;
  }

  list(options: ListOptions = {}): DocMeta[] {
    return [...this.#index.values()]
      .filter(doc => !options.kind || doc.kind === options.kind)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(doc => this.#meta(doc));
  }

  read(id: string): Doc {
    const normalized = normalizeId(id);
    const doc = this.#index.get(normalized);

    if (!doc) {
      throw new DocStoreError('not_found', `文档不存在：${normalized}`, {id: normalized});
    }

    return doc;
  }

  has(id: string): boolean {
    return this.#index.has(normalizeId(id));
  }

  /** 引用了该文档的其它文档。 */
  backlinks(id: string): DocMeta[] {
    const normalized = normalizeId(id);
    return this.list().filter(doc => doc.links.includes(normalized));
  }

  /** 在标题与正文里做最小可用的全文检索，返回命中片段。 */
  search(query: string, options: {limit?: number} = {}): SearchHit[] {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const doc of [...this.#index.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const titleIndex = doc.title.toLowerCase().indexOf(needle);
      const bodyIndex = doc.body.toLowerCase().indexOf(needle);

      if (titleIndex === -1 && bodyIndex === -1) {
        continue;
      }

      hits.push({
        ...this.#meta(doc),
        snippet: bodyIndex === -1 ? doc.title : snippetOf(doc.body, bodyIndex, needle.length),
      });

      if (hits.length >= (options.limit ?? 50)) {
        break;
      }
    }

    return hits;
  }

  /** 写入文档；baseRevision 不匹配时抛 conflict。默认在不存在时创建。 */
  async write(id: string, content: string, options: WriteOptions = {}): Promise<Doc> {
    const normalized = normalizeId(id);
    kindOfId(normalized);

    const current = this.#index.get(normalized);

    if (options.baseRevision !== undefined) {
      if (!current) {
        throw new DocStoreError('not_found', `文档不存在：${normalized}`, {id: normalized});
      }

      if (current.revision !== options.baseRevision) {
        throw new DocStoreError('conflict', `文档已被其他写入方修改：${normalized}`, {
          id: normalized,
          expected: options.baseRevision,
          actual: current.revision,
        });
      }
    }

    parseDoc(content);

    const filePath = pathOfId(this.root, normalized);
    await fs.mkdir(path.dirname(filePath), {recursive: true});

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);

    const doc = await this.#load(normalized, filePath);

    if (doc) {
      this.#index.set(normalized, doc);
      this.#emit({
        type: current ? 'changed' : 'created',
        id: normalized,
        kind: doc.kind,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
      });
    }

    return doc as Doc;
  }

  /** 追加内容；文档不存在时以 content 作为初始正文。 */
  async append(id: string, content: string): Promise<Doc> {
    const normalized = normalizeId(id);
    const current = this.#index.get(normalized);
    const base = current ? `${current.body.replace(/\n*$/, '')}\n\n` : '';
    const text = base + content;

    return current
      ? this.write(normalized, text, {baseRevision: current.revision})
      : this.write(normalized, text);
  }

  async remove(id: string, options: WriteOptions = {}): Promise<void> {
    const normalized = normalizeId(id);
    const current = this.#index.get(normalized);

    if (!current) {
      throw new DocStoreError('not_found', `文档不存在：${normalized}`, {id: normalized});
    }

    if (options.baseRevision !== undefined && current.revision !== options.baseRevision) {
      throw new DocStoreError('conflict', `文档已被其他写入方修改：${normalized}`, {
        id: normalized,
        expected: options.baseRevision,
        actual: current.revision,
      });
    }

    await fs.rm(current.path, {force: true});
    this.#index.delete(normalized);
    this.#emit({
      type: 'deleted',
      id: normalized,
      kind: current.kind,
      revision: current.revision,
      updatedAt: new Date().toISOString(),
    });
  }

  onChange(listener: (change: DocChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async scan(): Promise<void> {
    const files = await this.#walk(this.root);
    const next = new Map<string, Doc>();

    for (const filePath of files) {
      const id = idOfPath(this.root, filePath);

      if (!id) {
        continue;
      }

      const doc = await this.#load(id, filePath);

      if (doc) {
        next.set(id, doc);
      }
    }

    const previous = this.#index;
    this.#index = next;

    for (const [id, doc] of next) {
      const before = previous.get(id);

      if (!before) {
        this.#emitQuiet({type: 'created', id, kind: doc.kind, revision: doc.revision, updatedAt: doc.updatedAt});
      } else if (before.revision !== doc.revision) {
        this.#emitQuiet({type: 'changed', id, kind: doc.kind, revision: doc.revision, updatedAt: doc.updatedAt});
      }
    }

    for (const [id, doc] of previous) {
      if (!next.has(id)) {
        this.#emitQuiet({type: 'deleted', id, kind: doc.kind, revision: doc.revision, updatedAt: doc.updatedAt});
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#watcher?.close();
    this.#listeners.clear();
  }

  #meta(doc: Doc): DocMeta {
    const {frontmatter: _frontmatter, body: _body, ...meta} = doc;
    return meta;
  }

  async #load(id: string, filePath: string): Promise<Doc | undefined> {
    let text: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;

    try {
      [text, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }

    const {frontmatter, body} = parseDoc(text);
    const kind = kindOfId(id);
    const links = extractLinkIds(body, id);

    return {
      id,
      kind,
      title: resolveTitle(frontmatter, body, id),
      relPath: path.relative(this.root, filePath).replace(/\\/g, '/'),
      path: filePath,
      revision: computeRevision(text),
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
      links,
      frontmatter,
      body,
    };
  }

  async #walk(dir: string): Promise<string[]> {
    const result: string[] = [];
    let entries;

    try {
      entries = await fs.readdir(dir, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return result;
      }

      throw error;
    }

    for (const entry of entries) {
      const child = path.join(dir, entry.name);

      if (IGNORED.test(child)) {
        continue;
      }

      if (entry.isDirectory()) {
        result.push(...(await this.#walk(child)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        result.push(child);
      }
    }

    return result;
  }

  #startWatching(): void {
    this.#watcher = watch(this.root, {
      ignored: IGNORED,
      ignoreInitial: true,
      awaitWriteFinish: {stabilityThreshold: 80, pollInterval: 20},
    });

    const reload = async (filePath: string, type: 'created' | 'changed' | 'deleted') => {
      if (this.#closed) {
        return;
      }

      const id = idOfPath(this.root, filePath);

      if (!id) {
        return;
      }

      const before = this.#index.get(id);
      const doc = type === 'deleted' ? undefined : await this.#load(id, filePath);

      if (!doc) {
        if (!before) {
          return;
        }

        this.#index.delete(id);
        this.#emit({
          type: 'deleted',
          id,
          kind: before.kind,
          revision: before.revision,
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      this.#index.set(id, doc);

      if (before?.revision === doc.revision) {
        // 自己写入触发的回声，或内容未变。
        return;
      }

      this.#emit({
        type: before ? 'changed' : 'created',
        id,
        kind: doc.kind,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
      });
    };

    this.#watcher.on('add', filePath => void reload(filePath, 'created'));
    this.#watcher.on('change', filePath => void reload(filePath, 'changed'));
    this.#watcher.on('unlink', filePath => void reload(filePath, 'deleted'));
  }

  /** 等文件监听完初始化，并再对齐一次，避免启动瞬间的改动被当成初始状态吞掉。 */
  async #whenReady(): Promise<void> {
    const watcher = this.#watcher;

    if (!watcher) {
      return;
    }

    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 3000);

      watcher.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await this.scan();
  }

  #emit(change: DocChange): void {
    for (const listener of this.#listeners) {
      listener(change);
    }
  }

  #emitQuiet(change: DocChange): void {
    if (this.#listeners.size > 0) {
      this.#emit(change);
    }
  }
}
