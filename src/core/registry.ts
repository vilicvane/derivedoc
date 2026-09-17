import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface WorkspaceEntry {
  /** 项目根目录的绝对路径（`.derivedoc/` 所在） */
  root: string;
  /** 文档目录的绝对路径；缺省表示文档目录就是项目根（早期布局） */
  docs?: string;
  /** 最近一次打开时间（ISO） */
  lastOpened: string;
}

export interface WorkspaceRef {
  /** 项目根目录的绝对路径 */
  root: string;
  /** 文档目录的绝对路径 */
  docs: string;
  lastOpened: string;
  /** 稳定的短 id，用于 URL */
  id: string;
  name: string;
}

function registryFile(): string {
  const configHome = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'derivedoc', 'workspaces.json');
}

/**
 * 早期版本把注册表放在 `~/.derivedoc/` 里，而这个名字正是项目标记——家目录因此被当成
 * 项目根。这里只在读的时候兼容旧位置，写一律写新位置，下一次注册就完成搬家。
 */
function legacyRegistryFile(): string {
  return path.join(os.homedir(), '.derivedoc', 'workspaces.json');
}

/** 工作区短 id：路径的可读后缀 + 稳定哈希，避免在 URL 里塞绝对路径。 */
export function workspaceId(root: string): string {
  const resolved = path.resolve(root);
  const name = path.basename(resolved).replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase() || 'ws';
  let hash = 0;

  for (let index = 0; index < resolved.length; index++) {
    hash = (hash * 31 + resolved.charCodeAt(index)) | 0;
  }

  return `${name}-${(hash >>> 0).toString(36).slice(0, 4)}`;
}

export function toRef(entry: WorkspaceEntry): WorkspaceRef {
  const root = path.resolve(entry.root);

  return {
    root,
    docs: path.resolve(root, entry.docs ?? '.'),
    lastOpened: entry.lastOpened,
    id: workspaceId(root),
    name: path.basename(root) || root,
  };
}

export async function listWorkspaces(): Promise<WorkspaceRef[]> {
  let raw: string;

  try {
    raw = await fs.readFile(registryFile(), 'utf8');
  } catch {
    try {
      raw = await fs.readFile(legacyRegistryFile(), 'utf8');
    } catch {
      return [];
    }
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const entries = Array.isArray(parsed) ? (parsed as WorkspaceEntry[]) : [];

  return entries
    .filter(entry => typeof entry?.root === 'string')
    .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
    .map(toRef);
}

export async function registerWorkspace(paths: {root: string; docs: string}): Promise<WorkspaceRef> {
  const resolved = path.resolve(paths.root);
  const docs = path.resolve(paths.docs);
  const entries = await listWorkspaces();
  const next: WorkspaceEntry[] = [
    {root: resolved, docs, lastOpened: new Date().toISOString()},
    ...entries
      .filter(entry => entry.root !== resolved)
      .map(({root: entryRoot, docs: entryDocs, lastOpened}) => ({
        root: entryRoot,
        docs: entryDocs,
        lastOpened,
      })),
  ].slice(0, 30);

  const file = registryFile();
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return toRef(next[0]!);
}
