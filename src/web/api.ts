import type {
  ConversationRecord,
  Doc,
  DocMeta,
  GitStatus,
  SearchHit,
  WorkspaceRef,
} from './types.ts';

/** 接口报错：带上 HTTP 状态和服务端给的说明，调用方只负责加自己的上下文。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 出错时给用户看的那句话。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 所有工作区相关的接口都带 `ws`。 */
function query(workspace: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({...extra, ...(workspace ? {ws: workspace} : {})}).toString();
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    // 页面重载（dev 模式下前端重建会触发）会打断在途请求，等一拍再试一次；
    // 真连不上时第二次同样会失败，报错不变。
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      response = await fetch(url, init);
    } catch (retried) {
      throw new ApiError(0, `请求失败：${messageOf(retried ?? error)}`);
    }
  }

  const payload = (await response.json().catch(() => undefined)) as
    | ({error?: {message?: string}} & T)
    | undefined;

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.message ?? `HTTP ${response.status}`);
  }

  return payload as T;
}

function json(method: string, body: unknown): RequestInit {
  return {method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body)};
}

export const api = {
  /** 默认工作区：不知道 id 时问服务端。 */
  defaultWorkspace: () =>
    request<{defaultId: string}>('/api/workspaces').then(payload => payload.defaultId),

  workspace: (workspace: string) =>
    request<{ok: boolean; root: string; docs: string; files: number}>(
      `/api/health?${query(workspace)}`,
    ),

  workspaces: () =>
    request<{workspaces: WorkspaceRef[]; defaultId: string}>('/api/workspaces'),

  addWorkspace: (root: string, docs: string) =>
    request<{workspace: WorkspaceRef}>('/api/workspaces', json('POST', {root, docs})),

  docs: (workspace: string) =>
    request<{docs: DocMeta[]}>(`/api/docs?${query(workspace)}`).then(payload => payload.docs),

  doc: (workspace: string, id: string) => request<Doc>(`/api/doc?${query(workspace, {id})}`),

  writeDoc: (workspace: string, id: string, body: string, baseRevision?: string) =>
    request<{id: string; revision: string; updatedAt: string}>(
      `/api/doc?${query(workspace, {id})}`,
      json('PUT', {content: body, ...(baseRevision ? {baseRevision} : {})}),
    ),

  createDoc: (workspace: string, id: string, body: string) =>
    request<{id: string; revision: string; updatedAt: string}>(
      `/api/doc?${query(workspace, {id})}`,
      json('POST', {content: body}),
    ),

  removeDoc: (workspace: string, id: string) =>
    request<{ok: boolean}>(`/api/doc?${query(workspace, {id})}`, {method: 'DELETE'}),

  search: (workspace: string, text: string) =>
    request<{hits: SearchHit[]}>(`/api/search?${query(workspace, {q: text})}`).then(
      payload => payload.hits,
    ),

  backlinks: (workspace: string, id: string) =>
    request<{docs: DocMeta[]}>(`/api/backlinks?${query(workspace, {id})}`).then(
      payload => payload.docs,
    ),

  conversations: (workspace: string, doc: string) =>
    request<{conversations: ConversationRecord[]}>(
      `/api/conversations?${query(workspace, {doc})}`,
    ).then(payload => payload.conversations),

  gitStatus: (workspace: string) =>
    request<GitStatus>(`/api/git/status?${query(workspace)}`),

  gitDiff: (workspace: string, file: string | undefined, base: 'head' | 'index') =>
    request<{diff: string}>(
      `/api/git/diff?${query(workspace, {...(file ? {path: file} : {}), base})}`,
    ).then(payload => payload.diff),

  gitShow: (workspace: string, file: string, base: 'head' | 'index') =>
    request<{original: string; modified: string}>(
      `/api/git/show?${query(workspace, {path: file, ...(base === 'index' ? {base} : {})})}`,
    ),

  stage: (workspace: string, file?: string, unstage = false) =>
    request<GitStatus>(
      '/api/git/stage',
      json('POST', {...(file ? {path: file} : {}), ...(unstage ? {unstage: true} : {})}),
    ),

  commit: (workspace: string, message: string) =>
    request<{ok: boolean; sha?: string; error?: string}>('/api/git/commit', json('POST', {message})),

  /** 选区：界面选中一段就写它，收起来就清掉。 */
  putSelection: (workspace: string, selection: {doc: string; from: number; to: number; quote: string; revision?: string}) =>
    request<{selection: unknown}>(`/api/selection?${query(workspace)}`, json('PUT', selection)),

  clearSelection: (workspace: string) =>
    request<{selection: null}>(`/api/selection?${query(workspace)}`, {method: 'DELETE'}),
};
