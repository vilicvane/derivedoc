import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {Hono, type Context} from 'hono';

import {DocStoreError, isDocStoreError} from '../core/errors.ts';
import {gitCommit, gitDiff, gitShow, gitStatus} from '../core/git.ts';
import type {DocStore} from '../core/store.ts';
import type {DocKind} from '../core/types.ts';

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

export function createApp(store: DocStore): Hono {
  const app = new Hono();

  app.get('/api/health', c =>
    c.json({ok: true, root: store.root, docs: store.list().length}),
  );

  app.get('/api/docs', c => {
    const kind = c.req.query('kind');
    return c.json({docs: store.list(kind === 'source' || kind === 'derived' ? {kind: kind as DocKind} : {})});
  });

  app.get('/api/search', c => c.json({hits: store.search(c.req.query('q') ?? '')}));

  app.get('/api/git/status', async c => {
    try {
      return c.json(await gitStatus(store.root));
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get('/api/git/diff', async c => {
    try {
      return c.json({diff: await gitDiff(store.root, c.req.query('path'))});
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get('/api/git/show', async c => {
    const file = c.req.query('path');

    if (!file) {
      return c.json({error: {code: 'invalid_id', message: '缺少 path'}}, 400);
    }

    try {
      const absolute = path.resolve(store.root, file);

      if (!absolute.startsWith(path.resolve(store.root) + path.sep)) {
        return c.json({error: {code: 'invalid_id', message: 'path 越出工作区'}}, 400);
      }

      const modified = await fsp.readFile(absolute, 'utf8').catch(() => '');
      const original = await gitShow(store.root, file);

      if (!modified && !original) {
        return c.json({error: {code: 'not_found', message: `文件不存在：${file}`}}, 404);
      }

      return c.json({original, modified});
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.post('/api/git/commit', async c => {
    const body = (await c.req.json().catch(() => ({}))) as {message?: unknown};

    try {
      const status = await gitStatus(store.root);
      const message =
        typeof body.message === 'string' && body.message.trim()
          ? body.message
          : (status.message ?? '');
      const result = await gitCommit(store.root, message);
      return result.ok ? c.json(result) : c.json(result, 400);
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get('/api/doc', c => {
    const id = c.req.query('id');

    if (!id) {
      return c.json({error: {code: 'invalid_id', message: '缺少 id'}}, 400);
    }

    try {
      const doc = store.read(id);
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
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get('/api/backlinks', c => {
    const id = c.req.query('id');

    if (!id) {
      return c.json({error: {code: 'invalid_id', message: '缺少 id'}}, 400);
    }

    try {
      return c.json({docs: store.backlinks(id)});
    } catch (error) {
      return errorResponse(error);
    }
  });

  const write = (createOnly: boolean) => async (c: Context) => {
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

    try {
      const doc = await store.write(id, payload.content, {
        ...(createOnly ? {createOnly: true} : {}),
        ...(typeof payload.baseRevision === 'string'
          ? {baseRevision: payload.baseRevision}
          : {}),
      });
      return c.json({id: doc.id, revision: doc.revision, updatedAt: doc.updatedAt});
    } catch (error) {
      return errorResponse(error);
    }
  };

  app.put('/api/doc', write(false));
  app.post('/api/doc', write(true));

  app.delete('/api/doc', async c => {
    const id = c.req.query('id');

    if (!id) {
      return c.json({error: {code: 'invalid_id', message: '缺少 id'}}, 400);
    }

    try {
      await store.remove(id);
      return c.json({ok: true});
    } catch (error) {
      return errorResponse(error);
    }
  });

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
      const cache = relative === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable';
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
