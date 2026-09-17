import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface WorkspaceEntry {
  /** 工作区根目录的绝对路径 */
  root: string;
  /** 最近一次打开时间（ISO） */
  lastOpened: string;
}

export interface WorkspaceRef extends WorkspaceEntry {
  /** 稳定的短 id，用于 URL */
  id: string;
  name: string;
}

function registryFile(): string {
  const home = os.homedir();
  return path.join(home, '.derivedoc', 'workspaces.json');
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
  return {
    ...entry,
    id: workspaceId(entry.root),
    name: path.basename(entry.root) || entry.root,
  };
}

export async function listWorkspaces(): Promise<WorkspaceRef[]> {
  let raw: string;

  try {
    raw = await fs.readFile(registryFile(), 'utf8');
  } catch {
    return [];
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

export async function registerWorkspace(root: string): Promise<WorkspaceRef> {
  const resolved = path.resolve(root);
  const entries = await listWorkspaces();
  const next: WorkspaceEntry[] = [
    {root: resolved, lastOpened: new Date().toISOString()},
    ...entries
      .filter(entry => entry.root !== resolved)
      .map(({root: entryRoot, lastOpened}) => ({root: entryRoot, lastOpened})),
  ].slice(0, 30);

  const file = registryFile();
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return toRef(next[0]!);
}
