import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {Hono, type Context} from 'hono';

import {DocStoreError, isDocStoreError} from '../core/errors.ts';
import {readConversations} from '../core/conversations.ts';
import {describeWorkspace} from '../core/project.ts';
import {clearSelection, readSelection, writeSelection} from '../core/selection.ts';
import {
  gitCommit,
  gitDiff,
  gitShow,
  gitShowStaged,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../core/git.ts';
import type {DocKind} from '../core/types.ts';
import type {WorkspaceHub, WorkspaceView} from './hub.ts';

/**
 * 前端产物位置。打包后 server 代码可能在 bld/cli/chunks 里，所以从当前文件往上找
 * `bld/web`，而不是写死相对层级。
 */
function resolveWebRoot(): string | undefined {
  let dir = import.meta.dirname;

  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(dir, 'bld/web');

    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  return undefined;
}

const WEB_ROOT = resolveWebRoot();

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const PLACEHOLDER = `<!doctype html>
<meta charset="utf-8" />
<title>derivedoc</title>
<body style="font:14px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>derivedoc</h1>
<p>服务已经起来了，但 web 界面还没构建。</p>
<p>运行 <code>npm run web:build</code> 生成界面，或者直接用 <code>/api/docs</code> 和 MCP 接口。</p>
</body>
`;

function errorResponse(error: unknown): Response {
  if (isDocStoreError(error)) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;

    return Response.json(
      {error: {code: error.code, message: error.message, ...error.detail}},
      {status},
    );
  }

  return Response.json({error: {code: 'internal', message: String(error)}}, {status: 500});
}

export function createApp(hub: WorkspaceHub): Hono {
  const app = new Hono();

  /** 每次请求解析工作区：?ws=<id>，缺省用启动时的工作区。 */
  const withStore = async (
    c: Context,
    handler: (view: WorkspaceView) => Response | Promise<Response>,
  ): Promise<Response> => {
    const id = c.req.query('ws') ?? hub.defaultId;

    try {
      const view = await hub.get(id);

      if (!view) {
        return c.json({error: {code: 'not_found', message: `没有这个工作区：${id}`}}, 404);
      }

      return await handler(view);
    } catch (error) {
      return errorResponse(error);
    }
  };

  app.get('/api/workspaces', async c => c.json({workspaces: await hub.list(), defaultId: hub.defaultId}));

  /** 界面填路径时先问一句：这是哪个工作区、文档目录在哪、要不要新建。 */
  app.get('/api/resolve', async c => {
    const input = c.req.query('path');

    if (!input?.trim()) {
      return c.json({error: {code: 'invalid_id', message: '缺少 path'}}, 400);
    }

    const docs = c.req.query('docs');
    const resolved = await describeWorkspace(input.trim(), docs?.trim() || undefined, {
      cwd: process.cwd(),
    });

    if (resolved.root === path.resolve(os.homedir())) {
      return c.json(
        {error: {code: 'invalid_id', message: '不把家目录当工作区：请填具体项目目录'}},
        400,
      );
    }

    return c.json({
      root: resolved.root,
      docs: resolved.docs,
      exists: resolved.exists,
      recorded: resolved.recorded,
      name: path.basename(resolved.root) || resolved.root,
    });
  });

  app.post('/api/workspaces', async c => {
    const body = (await c.req.json().catch(() => ({}))) as {root?: unknown; docs?: unknown};

    if (typeof body.root !== 'string' || !body.root.trim()) {
      return c.json({error: {code: 'invalid_id', message: '需要一个工作区路径'}}, 400);
    }

    try {
      const docs = typeof body.docs === 'string' ? body.docs.trim() : '';
      return c.json({workspace: await hub.add(body.root.trim(), docs || undefined)});
    } catch (error) {
      return c.json({error: {code: 'invalid_id', message: String((error as Error).message)}}, 400);
    }
  });

  app.get('/api/health', c =>
    withStore(c, view =>
      c.json({
        ok: true,
        root: view.ref.root,
        docs: view.ref.docs,
        files: view.store.list().length,
      }),
    ),
  );

  app.get('/api/docs', c =>
    withStore(c, view => {
      const kind = c.req.query('kind');
      return c.json({
        docs: view.store.list(kind === 'source' || kind === 'derived' ? {kind: kind as DocKind} : {}),
      });
    }),
  );

  app.get('/api/search', c =>
    withStore(c, view => c.json({hits: view.store.search(c.req.query('q') ?? '')})),
  );

  /** 对话记录（本地缓存）：可按文档过滤，看某篇是谁在什么对话里定下来的。 */
  app.get('/api/conversations', c =>
    withStore(c, async view => {
      const doc = c.req.query('doc');
      const limit = Number(c.req.query('limit') ?? 200);
      const all = await readConversations(view.ref.root);
      const filtered = doc
        ? all.filter(record => record.captures.some(capture => capture.changed.includes(doc)))
        : all;

      return c.json({conversations: filtered.slice(0, Number.isFinite(limit) ? limit : 200)});
    }),
  );

  app.get('/api/git/status', c =>
    withStore(c, async view => c.json(await gitStatus(view.ref.root, view.ref.docs))),
  );

  app.get('/api/git/diff', c =>
    withStore(c, async view =>
      c.json({
        diff: await gitDiff(
          view.ref.root,
          view.ref.docs,
          c.req.query('path'),
          c.req.query('base') === 'index' ? 'index' : 'head',
        ),
      }),
    ),
  );

  app.post('/api/git/stage', c =>
    withStore(c, async view => {
      const body = (await c.req.json().catch(() => ({}))) as {path?: unknown; unstage?: unknown};
      const file = typeof body.path === 'string' ? body.path : undefined;

      if (body.unstage) {
        await gitUnstage(view.ref.root, view.ref.docs, file);
      } else {
        await gitStage(view.ref.root, view.ref.docs, file);
      }

      return c.json(await gitStatus(view.ref.root, view.ref.docs));
    }),
  );

  app.get('/api/git/show', c =>
    withStore(c, async view => {
      const file = c.req.query('path');

      if (!file) {
        return c.json({error: {code: 'invalid_id', message: '缺少 path'}}, 400);
      }

      const rootPrefix = path.resolve(view.ref.docs) + path.sep;
      const absolute = path.resolve(view.ref.docs, file);

      if (!absolute.startsWith(rootPrefix)) {
        return c.json({error: {code: 'invalid_id', message: 'path 越出文档目录'}}, 400);
      }

      const modified = await fsp.readFile(absolute, 'utf8').catch(() => '');
      const original =
        c.req.query('base') === 'index'
          ? await gitShowStaged(view.ref.root, view.ref.docs, file)
          : await gitShow(view.ref.root, view.ref.docs, file);

      if (!modified && !original) {
        return c.json({error: {code: 'not_found', message: `文件不存在：${file}`}}, 404);
      }

      return c.json({original, modified});
    }),
  );

  app.post('/api/git/commit', c =>
    withStore(c, async view => {
      const body = (await c.req.json().catch(() => ({}))) as {message?: unknown};
      const status = await gitStatus(view.ref.root, view.ref.docs);
      const message =
        typeof body.message === 'string' && body.message.trim()
          ? body.message
          : (status.message ?? '');
      const result = await gitCommit(view.ref.root, view.ref.docs, message);
      return result.ok ? c.json(result) : c.json(result, 400);
    }),
  );

  app.get('/api/doc', c =>
    withStore(c, view => {
      const id = c.req.query('id');

      if (!id) {
        return c.json({error: {code: 'invalid_id', message: '缺少 id'}}, 400);
      }

      const doc = view.store.read(id);
      return c.json({
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        relPath: doc.relPath,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
        links: doc.links,
        frontmatter: doc.frontmatter,
        body: doc.body,
      });
    }),
  );

  app.get('/api/backlinks', c =>
    withStore(c, view => {
      const id = c.req.query('id');

      if (!id) {
        return c.json({error: {code: 'invalid_id', message: '缺少 id'}}, 400);
      }

      return c.json({docs: view.store.backlinks(id)});
    }),
  );

  /** 界面里选中的一段：agent 之后用 `dd selection` 读的就是它。 */
  app.get('/api/selection', c =>
    withStore(c, async view => c.json({selection: (await readSelection(view.ref.root)) ?? null})),
  );

  app.put('/api/selection', c =>
    withStore(c, async view => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const doc = typeof body['doc'] === 'string' ? body['doc'] : '';
      const quote = typeof body['quote'] === 'string' ? body['quote'] : '';

      if (!doc || !quote.trim()) {
        return c.json({error: {code: 'invalid_content', message: '缺少 doc 或 quote'}}, 400);
      }

      const line = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
      const selection = {
        doc,
        from: line(body['from']),
        to: line(body['to']),
        quote,
        ...(typeof body['revision'] === 'string' ? {revision: body['revision']} : {}),
        at: new Date().toISOString(),
        channel: 'web',
      };

      await writeSelection(view.ref.root, selection);
      return c.json({selection});
    }),
  );

  app.delete('/api/selection', c =>
    withStore(c, async view => {
      await clearSelection(view.ref.root);
      return c.json({selection: null});
    }),
  );

  const write = (createOnly: boolean) => async (c: Context) =>
    withStore(c, async view => {
      const id = c.req.query('id');

      if (!id) {
        return c.json({error: {code: 'invalid_id', message: '缺少 id'}}, 400);
      }

      let payload: {content?: unknown; baseRevision?: unknown};

      try {
        payload = await c.req.json();
      } catch {
        return c.json({error: {code: 'invalid_content', message: '请求体不是合法 JSON'}}, 400);
      }

      if (typeof payload.content !== 'string') {
        return c.json({error: {code: 'invalid_content', message: '缺少 content'}}, 400);
      }

      const doc = await view.store.write(id, payload.content, {
        ...(createOnly ? {createOnly: true} : {}),
        ...(typeof payload.baseRevision === 'string'
          ? {baseRevision: payload.baseRevision}
          : {}),
      });
      return c.json({id: doc.id, revision: doc.revision, updatedAt: doc.updatedAt});
    });

  app.put('/api/doc', write(false));
  app.post('/api/doc', write(true));

  app.delete('/api/doc', c =>
    withStore(c, async view => {
      const id = c.req.query('id');

      if (!id) {
        return c.json({error: {code: 'invalid_id', message: '缺少 id'}}, 400);
      }

      await view.store.remove(id);
      return c.json({ok: true});
    }),
  );

  app.get('*', async c => {
    const url = new URL(c.req.url);
    const relative = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = WEB_ROOT ? path.join(WEB_ROOT, relative) : '';

    if (!WEB_ROOT || !filePath.startsWith(WEB_ROOT + path.sep)) {
      if (relative === '/index.html') {
        return c.html(PLACEHOLDER);
      }

      return c.text('not found', 404);
    }

    try {
      const body = await fsp.readFile(filePath);
      const type = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
      // 带哈希的静态资源可以长缓存，index.html 必须每次校验，否则界面会停在旧版本上。
      // 只有 Vite 产出的哈希资源能长缓存：favicon 这类固定名字的文件改了要立刻生效。
      const cache = relative.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store';
      return new Response(new Uint8Array(body), {
        headers: {'content-type': type, 'cache-control': cache},
      });
    } catch {
      // SPA 路由：不是静态资源的路径一律交给前端路由，用 index.html 兜底。
      const isAsset = path.extname(relative) !== '';

      if (!isAsset) {
        const fallback = await fsp
          .readFile(path.join(WEB_ROOT, 'index.html'))
          .catch(() => undefined);

        if (fallback) {
          return new Response(new Uint8Array(fallback), {
            headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
          });
        }
      }

      return relative === '/index.html' ? c.html(PLACEHOLDER) : c.text('not found', 404);
    }
  });

  return app;
}

export {DocStoreError};
