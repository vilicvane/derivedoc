import path from 'node:path';

import {DocStoreError} from './errors.ts';
import type {DocKind} from './types.ts';

export const DOC_KINDS: readonly DocKind[] = ['source', 'derived'];

const ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/i;

export function normalizeId(id: string): string {
  const normalized = id.trim().replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\/+/, '');

  if (!normalized || !ID_PATTERN.test(normalized) || normalized.includes('..')) {
    throw new DocStoreError('invalid_id', `不合法的文档 id：${id}`);
  }

  return normalized;
}

export function kindOfId(id: string): DocKind {
  for (const kind of DOC_KINDS) {
    if (id === kind || id.startsWith(`${kind}/`)) {
      return kind;
    }
  }

  throw new DocStoreError(
    'invalid_id',
    `文档 id 必须以 ${DOC_KINDS.map(k => `${k}/`).join(' 或 ')} 开头：${id}`,
  );
}

export function pathOfId(root: string, id: string): string {
  const resolved = path.resolve(root, `${id}.md`);
  const rootWithSep = path.resolve(root) + path.sep;

  if (!resolved.startsWith(rootWithSep)) {
    throw new DocStoreError('invalid_id', `文档 id 越出项目目录：${id}`);
  }

  return resolved;
}

export function idOfPath(root: string, filePath: string): string | undefined {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');

  if (!rel.endsWith('.md')) {
    return undefined;
  }

  const id = rel.slice(0, -3);

  try {
    kindOfId(id);
  } catch {
    return undefined;
  }

  return id;
}
