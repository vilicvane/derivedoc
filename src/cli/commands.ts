import process from 'node:process';

import {DocStoreError, isDocStoreError} from '../core/errors.ts';
import {findProjectRoot, initProject} from '../core/project.ts';
import {DocStore} from '../core/store.ts';
import type {DocKind} from '../core/types.ts';
import {CliError} from './args.ts';

export interface CommandOptions {
  json: boolean;
  kind?: string;
  baseRevision?: string;
  content?: string;
}

/** agent 与人都用这几个子命令读写文档，服务不必启动。 */
export async function runCommand(
  dir: string,
  command: string,
  rest: string[],
  options: CommandOptions,
): Promise<void> {
  switch (command) {
    case 'root':
      return printProjectRoot(dir, options);
    case 'ls':
      return listDocs(dir, options);
    case 'read':
      return printDocBody(dir, takeId(rest, 'read').id, options);
    case 'stat':
      return printDocMeta(dir, takeId(rest, 'stat').id, options);
    case 'write':
      return writeDoc(dir, takeId(rest, 'write'), options);
    case 'append':
      return appendDoc(dir, takeId(rest, 'append'), options);
    case 'rm':
      return removeDoc(dir, takeId(rest, 'rm').id, options);
    default:
      throw new CliError(
        `未知子命令：${command}（可用：root、ls、read、stat、write、append、rm；省略子命令则启动服务）`,
      );
  }
}

/** 判断目录属于哪个 derivedoc 工作区；不属于则退出码 1。 */
async function printProjectRoot(dir: string, options: CommandOptions): Promise<void> {
  const root = await findProjectRoot(dir);

  if (!root) {
    if (options.json) {
      printJson({root: null});
    } else {
      process.stderr.write(`${dir} 不在 derivedoc 工作区\n`);
    }

    process.exitCode = 1;
    return;
  }

  if (options.json) {
    printJson({root});
    return;
  }

  process.stdout.write(`${root}\n`);
}

async function listDocs(dir: string, options: CommandOptions): Promise<void> {
  const store = await DocStore.open(dir, {watch: false});

  try {
    const docs = store.list(parseKind(options.kind));

    if (options.json) {
      printJson({root: store.root, docs});
      return;
    }

    for (const doc of docs) {
      process.stdout.write(
        `${doc.id}\t${doc.kind}\t${doc.revision}\t${doc.title}\t${doc.updatedAt}\n`,
      );
    }
  } finally {
    await store.close();
  }
}

async function printDocBody(dir: string, id: string, options: CommandOptions): Promise<void> {
  const store = await DocStore.open(dir, {watch: false});

  try {
    const doc = store.read(id);

    if (options.json) {
      printJson({
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
        frontmatter: doc.frontmatter,
        body: doc.body,
      });
      return;
    }

    process.stdout.write(doc.body.endsWith('\n') ? doc.body : `${doc.body}\n`);
  } finally {
    await store.close();
  }
}

async function printDocMeta(dir: string, id: string, options: CommandOptions): Promise<void> {
  const store = await DocStore.open(dir, {watch: false});

  try {
    const doc = store.read(id);

    if (options.json) {
      const {body: _body, frontmatter: _frontmatter, ...meta} = doc;
      printJson(meta);
      return;
    }

    process.stdout.write(`${doc.revision}\n`);
  } finally {
    await store.close();
  }
}

async function writeDoc(
  dir: string,
  target: {id: string; inline: string},
  options: CommandOptions,
): Promise<void> {
  await initProject(dir);
  const store = await DocStore.open(dir, {watch: false});

  try {
    const id = target.id;
    const content = await readContent(options, target.inline);
    const doc =
      options.baseRevision === undefined
        ? await store.write(id, content)
        : await store.write(id, content, {baseRevision: options.baseRevision});
    printWriteResult(doc, options);
  } finally {
    await store.close();
  }
}

async function appendDoc(
  dir: string,
  target: {id: string; inline: string},
  options: CommandOptions,
): Promise<void> {
  await initProject(dir);
  const store = await DocStore.open(dir, {watch: false});

  try {
    const id = target.id;
    const content = await readContent(options, target.inline);
    const doc = await store.append(id, content);
    printWriteResult(doc, options);
  } finally {
    await store.close();
  }
}

async function removeDoc(dir: string, id: string, options: CommandOptions): Promise<void> {
  const store = await DocStore.open(dir, {watch: false});

  try {
    await store.remove(
      id,
      options.baseRevision === undefined ? {} : {baseRevision: options.baseRevision},
    );

    if (options.json) {
      printJson({id, removed: true});
      return;
    }

    process.stdout.write(`${id} 已删除\n`);
  } finally {
    await store.close();
  }
}

function printWriteResult(
  doc: {id: string; revision: string; updatedAt: string},
  options: CommandOptions,
): void {
  if (options.json) {
    printJson({id: doc.id, revision: doc.revision, updatedAt: doc.updatedAt});
    return;
  }

  process.stdout.write(`${doc.id}\t${doc.revision}\n`);
}

function parseKind(kind: string | undefined): {kind?: DocKind} {
  if (kind === undefined) {
    return {};
  }

  if (kind !== 'source' && kind !== 'derived') {
    throw new CliError(`--kind 只能是 source 或 derived，收到：${kind}`);
  }

  return {kind};
}

/** 取 id，并把后面多余的参数当作内联内容（用空格拼接）。 */
function takeId(rest: string[], command: string): {id: string; inline: string} {
  const [id, ...tail] = rest;

  if (!id) {
    throw new CliError(`${command} 需要文档 id，例如：dd <目录> ${command} source/requirements`);
  }

  return {id, inline: tail.join(' ')};
}

async function readContent(options: CommandOptions, inline: string): Promise<string> {
  if (options.content !== undefined) {
    return options.content;
  }

  if (inline) {
    return inline.endsWith('\n') ? inline : `${inline}\n`;
  }

  if (process.stdin.isTTY) {
    throw new CliError('需要内容：直接写在命令里、用管道传入，或者用 --content 指定');
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  const content = Buffer.concat(chunks).toString('utf8');

  if (!content.trim()) {
    throw new CliError('内容为空');
  }

  return content;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function reportError(error: unknown, json: boolean): number {
  if (isDocStoreError(error)) {
    if (json) {
      printJson({error: {code: error.code, message: error.message, ...error.detail}});
    } else {
      process.stderr.write(`error[${error.code}] ${error.message}\n`);
    }

    return 1;
  }

  if (error instanceof CliError) {
    process.stderr.write(`error ${error.message}\n`);
    return 2;
  }

  if (error instanceof DocStoreError) {
    process.stderr.write(`error ${error.message}\n`);
    return 1;
  }

  process.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}
