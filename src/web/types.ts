/** 界面用到的数据类型：和服务端接口一一对应。 */

export type DocKind = 'source' | 'derived';

export interface DocMeta {
  id: string;
  kind: DocKind;
  title: string;
  relPath: string;
  revision: string;
  updatedAt: string;
  links: string[];
}

export interface Doc extends DocMeta {
  body: string;
}

/** `/ws` 推来的文档变更。 */
export interface Change {
  type: 'created' | 'changed' | 'deleted';
  id: string;
  revision: string;
}

/** 磁盘上出现了新版本，当前草稿还没保存。 */
export interface Incoming {
  id: string;
  revision: string;
  body: string;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'info' | 'warn' | 'error';
  text: string;
  /** 同 key 的提示原地更新（比如「保存中…」变成「已保存」），不再叠一条。 */
  key?: string;
}

export interface ConversationRecord {
  type: 'message';
  at: string;
  sessionId: string;
  turnId?: string;
  channel: string;
  text: string;
  captures: Array<{
    changed: string[];
    thinking?: string;
    elapsedMs: number;
    code: number;
  }>;
}

export interface SearchHit extends DocMeta {
  snippet: string;
}

export interface GitChange {
  path: string;
  index: string;
  worktree: string;
  added?: number;
  removed?: number;
}

export interface GitStatus {
  available: boolean;
  reason?: string;
  branch?: string;
  changes: GitChange[];
  /** `.derivedoc/commit-message` 里那句；跟不上这批改动时为空 */
  message?: string;
  /** 存着的那句描述的是更早的一批改动 */
  messageStale?: boolean;
  otherChanges: number;
}

export interface WorkspaceInfo {
  root: string;
  docs: string;
  name: string;
}

export interface WorkspaceRef {
  id: string;
  name: string;
  root: string;
  docs: string;
  lastOpened: string;
  open: boolean;
}

/** 工作区里还有没进暂存区的改动（含未跟踪）。 */
export function hasUnstaged(change: GitChange): boolean {
  return change.worktree !== ' ' || change.index === '?';
}

/** 已经有内容在暂存区里。 */
export function isStaged(change: GitChange): boolean {
  return change.index !== ' ' && change.index !== '?';
}
