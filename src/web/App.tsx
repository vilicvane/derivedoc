import MarkdownIt from 'markdown-it';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Columns2,
  GitCommitHorizontal,
  Minus,
  Plus,
  Quote,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';

import {diffLines, formatSummary, parseGitDiff, summarizeDiff} from '../core/diff.ts';
import {DEFAULT_DOCS_DIR} from '../core/defaults.ts';
import {resolveDocId} from '../core/links.ts';
import {MarkdownDiff, MarkdownEditor, type Pick} from './editors.tsx';

const markdown = new MarkdownIt({html: false, linkify: true});

function draftMessage(changes: GitChange[]): string {
  if (changes.length === 0) {
    return '';
  }

  const [first] = changes;
  return changes.length === 1
    ? `更新 ${first!.path}`
    : `更新 ${first!.path} 等 ${changes.length} 个文档`;
}

type DocKind = 'source' | 'derived';

interface DocMeta {
  id: string;
  kind: DocKind;
  title: string;
  relPath: string;
  revision: string;
  updatedAt: string;
  links: string[];
}

interface Doc extends DocMeta {
  body: string;
}

interface Change {
  type: 'created' | 'changed' | 'deleted';
  id: string;
  revision: string;
}

interface Incoming {
  id: string;
  revision: string;
  body: string;
}

interface Toast {
  id: number;
  kind: 'ok' | 'info' | 'warn' | 'error';
  text: string;
  /** 同 key 的提示原地更新（比如「保存中…」变成「已保存」），不再叠一条。 */
  key?: string;
}

interface ConversationRecord {
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

interface SearchHit extends DocMeta {
  snippet: string;
}

interface GitChange {
  path: string;
  index: string;
  worktree: string;
  added?: number;
  removed?: number;
}

interface GitStatus {
  available: boolean;
  reason?: string;
  branch?: string;
  changes: GitChange[];
  message?: string;
  otherChanges: number;
}

/** 工作区里还有没进暂存区的改动（含未跟踪）。 */
function hasUnstaged(change: GitChange): boolean {
  return change.worktree !== ' ' || change.index === '?';
}

/** 已经有内容在暂存区里。 */
function isStaged(change: GitChange): boolean {
  return change.index !== ' ' && change.index !== '?';
}

interface TreeNode {
  name: string;
  path: string;
  kind: DocKind;
  depth: number;
  children: TreeNode[];
  doc?: DocMeta;
}

function buildTree(docs: DocMeta[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();

  // 两个根始终存在：空项目也要有新建入口，并让层级结构可见。
  for (const kind of ['source', 'derived'] as const) {
    const root: TreeNode = {name: kind, path: kind, kind, depth: 0, children: []};
    nodes.set(kind, root);
    roots.push(root);
  }

  for (const doc of [...docs].sort((a, b) => a.id.localeCompare(b.id))) {
    const segments = doc.id.split('/');
    let list = roots;
    let prefix = '';

    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let node = nodes.get(prefix);

      if (!node) {
        node = {name: segment, path: prefix, kind: doc.kind, depth: index, children: []};
        nodes.set(prefix, node);
        list.push(node);
      }

      if (index === segments.length - 1) {
        node.doc = doc;
      }

      list = node.children;
    });
  }

  // source 在前：界面主要给用户看，用户关心的是自己定下的东西。
  const layerOrder: Record<DocKind, number> = {source: 0, derived: 1};
  const sortNodes = (list: TreeNode[]): TreeNode[] =>
    list.sort((a, b) => {
      const layer = layerOrder[a.kind] - layerOrder[b.kind];

      if (a.depth === 0 && layer !== 0) {
        return layer;
      }

      // 文件夹排在文件前面：先扫结构，再看具体是哪篇。
      const folder = (a.doc ? 1 : 0) - (b.doc ? 1 : 0);
      return folder !== 0 ? folder : a.name.localeCompare(b.name);
    });

  sortNodes(roots);

  for (const node of nodes.values()) {
    if (node.children.length > 0) {
      sortNodes(node.children);
    }
  }

  return roots;
}

function fileName(id: string): string {
  return `${id.split('/').pop() ?? id}.md`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function App() {
  return (
    <Routes>
      <Route element={<Workspace />} path="/w/:ws" />
      <Route element={<Workspace />} path="/w/:ws/d/*" />
      <Route element={<Workspace />} path="/w/:ws/changes" />
      <Route element={<DefaultWorkspace />} path="*" />
    </Routes>
  );
}

/** 没有指定工作区时，问服务端默认是哪个，然后跳过去。 */
function DefaultWorkspace() {
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/workspaces').catch(() => undefined);
      const payload = response?.ok
        ? ((await response.json()) as {defaultId: string})
        : undefined;

      if (payload?.defaultId) {
        navigate(`/w/${payload.defaultId}/`, {replace: true});
      } else {
        setFailed(true);
      }
    })();
  }, [navigate]);

  return (
    <div className="placeholder">
      <p>{failed ? '连不上 derivedoc 服务' : '正在打开工作区…'}</p>
    </div>
  );
}

function Workspace() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [doc, setDoc] = useState<Doc>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [incoming, setIncoming] = useState<Incoming>();
  const [showIncoming, setShowIncoming] = useState(false);
  const [backlinks, setBacklinks] = useState<DocMeta[]>([]);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState<DocKind>();
  const [creatingFolder, setCreatingFolder] = useState<string>();
  const [newId, setNewId] = useState('');
  const [fileDiff, setFileDiff] = useState<{original: string; modified: string}>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [git, setGit] = useState<GitStatus>();
  const [gitFile, setGitFile] = useState<string>();
  const [gitDiffText, setGitDiffText] = useState('');
  const [gitSides, setGitSides] = useState<{original: string; modified: string}>();
  const [reviewBase, setReviewBase] = useState<'head' | 'index'>('head');
  const [gitMessage, setGitMessage] = useState('');
  const [gitBusy, setGitBusy] = useState(false);
  const [workspace, setWorkspace] = useState<{root: string; docs: string; name: string}>();
  const [workspaceList, setWorkspaceList] = useState<
    Array<{id: string; name: string; root: string; docs: string; open: boolean}>
  >([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newDocs, setNewDocs] = useState('');
  const [provenance, setProvenance] = useState<ConversationRecord[]>([]);
  const [showProvenance, setShowProvenance] = useState(false);

  useEffect(() => {
    if (!switcherOpen) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSwitcherOpen(false);
      }
    };

    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [switcherOpen]);

  // 路由即状态：/d/<id> 看文档，?diff=1 看改动，/changes 看提交面板。
  const navigate = useNavigate();
  const params = useParams();
  const {pathname} = useLocation();
  const [searchParams] = useSearchParams();
  const workspaceId = params.ws ?? '';
  const selected = params['*'] ? decodeURIComponent(params['*']) : undefined;
  const gitOpen = pathname.endsWith('/changes');
  /** 所有接口都带上当前工作区。 */
  const wsQuery = useCallback(
    (extra: Record<string, string> = {}) =>
      new URLSearchParams({...extra, ...(workspaceId ? {ws: workspaceId} : {})}).toString(),
    [workspaceId],
  );
  const docUrl = useCallback(
    (id: string, options: {diff?: boolean} = {}) =>
      `/w/${workspaceId}/d/${id}${options.diff ? '?diff=1' : ''}`,
    [workspaceId],
  );
  const diffMode: 'file' | 'incoming' | undefined =
    incoming && showIncoming
      ? 'incoming'
      : searchParams.get('diff') === '1'
        ? 'file'
        : undefined;

  const openDoc = useCallback(
    (id: string, options: {diff?: boolean} = {}) => {
      setIncoming(undefined);
      setShowIncoming(false);
      navigate(docUrl(id, options));
    },
    [navigate, docUrl],
  );

  const draft = selected ? drafts[selected] ?? doc?.body ?? '' : '';
  const dirty = doc !== undefined && draft !== doc.body;

  /**
   * 有没有未保存的改动。只有当前这篇能拿磁盘正文比对；已经切走的文档只剩草稿，
   * 有草稿就算有改动（编辑器只在用户真的敲字时才写草稿）。
   */
  const hasDraft = useCallback(
    (id: string) =>
      drafts[id] !== undefined && (doc?.id === id ? drafts[id] !== doc.body : true),
    [doc, drafts],
  );

  // 选中一段就记下来：agent 用 `dd selection` 读到的就是它。
  const pickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pickSet = useRef(false);
  const recordPick = useCallback(
    (pick: Pick | undefined) => {
      // 选区收起来就把记下的撤掉：没有提示的选区留在那儿，agent 与用户看到的就对不上了。
      if (!pick) {
        clearTimeout(pickTimer.current);

        if (pickSet.current) {
          pickSet.current = false;
          void fetch(`/api/selection?${wsQuery()}`, {method: 'DELETE'}).catch(() => undefined);
        }

        return;
      }

      pickSet.current = true;
      clearTimeout(pickTimer.current);
      pickTimer.current = setTimeout(() => {
        void (async () => {
          // 审阅页没有路由里的文档 id，选的是当前那篇 diff。
          const id = gitOpen ? gitFile?.replace(/\.md$/i, '') : selected;

          if (!id) {
            return;
          }

          const response = await fetch(`/api/selection?${wsQuery()}`, {
            method: 'PUT',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
              doc: id,
              from: pick.from,
              to: pick.to,
              quote: pick.text,
              ...(doc?.id === id ? {revision: doc.revision} : {}),
            }),
          }).catch(() => undefined);

          if (!response?.ok) {
            return;
          }
        })();
      }, 300);
    },
    [doc, gitFile, gitOpen, selected, wsQuery],
  );

  const stateRef = useRef({doc, draft, selected});
  const pendingWriteRef = useRef<{id: string; body: string} | undefined>(undefined);
  const focusEditorRef = useRef(false);
  const autoPickedRef = useRef(false);
  /** 提示条的最新值与各自的定时器：同 key 就地更新，不叠两条。 */
  const toastsRef = useRef<Toast[]>([]);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  stateRef.current = {doc, draft, selected};
  toastsRef.current = toasts;

  const notify = useCallback((text: string, key?: string) => {
    if (!text) {
      return;
    }

    const kind: Toast['kind'] = /失败|错误|无法|不在/.test(text)
      ? 'error'
      : /已保存|已提交|已删除|已载入|生效/.test(text)
        ? 'ok'
        : 'info';
    const existing = key ? toastsRef.current.find(toast => toast.key === key) : undefined;
    const id = existing?.id ?? Date.now() + Math.random();

    const next: Toast = {id, kind, text, ...(key ? {key} : {})};
    setToasts(current => {
      const rest = current.filter(toast => toast.id !== id);
      return existing
        ? current.map(toast => (toast.id === id ? next : toast))
        : [...rest.slice(-2), next];
    });

    if (existing) {
      clearTimeout(timersRef.current.get(id));
    }

    timersRef.current.set(
      id,
      setTimeout(() => {
        timersRef.current.delete(id);
        setToasts(current => current.filter(toast => toast.id !== id));
      }, 3200),
    );
  }, []);

  const setStatus = notify;

  const changeByPath = useMemo(
    () => new Map((git?.changes ?? []).map(change => [change.path, change])),
    [git],
  );

  /** 当前这篇文档的 git 状态：用来决定「暂存 / 取消暂存」显示哪个。 */
  const docChange = doc ? changeByPath.get(doc.relPath) : undefined;

  /**
   * 主界面的 diff 以暂存区为基准：这篇有暂存内容时是「与暂存区对比」，
   * 没暂存过时基准就是 HEAD（暂存区与 HEAD 一致），所以直接说「与 HEAD 对比」。
   */
  const againstStaged = docChange !== undefined && isStaged(docChange);
  const diffCaption = againstStaged ? '与暂存区对比' : '与 HEAD 对比';
  const diffTitle = againstStaged ? '看与暂存区的对比' : '看与 HEAD 的对比';

  /** 已暂存的文件数：提交时优先只带这些，没暂存过就整层提交。 */
  const stagedCount = (git?.changes ?? []).filter(
    change => change.index !== ' ' && change.index !== '?',
  ).length;

  /** 这次提交会带上几篇：暂存过就按暂存的算，否则算上全部文档改动。 */
  const commitCount = stagedCount > 0 ? stagedCount : (git?.changes.length ?? 0);

  /** 路由里的 id 不在文档列表里：多半是失效链接。 */
  const missingDoc = Boolean(selected) && docs.length > 0 && !docs.some(item => item.id === selected);

  const tree = useMemo(() => buildTree(docs), [docs]);

  const flatDocs = useMemo(() => {
    const list: DocMeta[] = [];
    const walk = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.doc) {
          list.push(node.doc);
        } else {
          walk(node.children);
        }
      }
    };
    walk(tree);
    return list;
  }, [tree]);

  const loadDocs = useCallback(async () => {
    const response = await fetch(`/api/docs?${wsQuery()}`);
    const payload = (await response.json()) as {docs: DocMeta[]};
    setDocs(payload.docs);
    return payload.docs;
  }, [wsQuery]);

  const loadWorkspaces = useCallback(async () => {
    const response = await fetch('/api/workspaces');

    if (!response.ok) {
      return;
    }

    setWorkspaceList(((await response.json()) as {workspaces: typeof workspaceList}).workspaces);
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/health?${wsQuery()}`);

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as {root: string; docs: string};
      const name = payload.root.split('/').filter(Boolean).pop() ?? payload.root;
      setWorkspace({root: payload.root, docs: payload.docs, name});
      document.title = `${name} · derivedoc`;
    })();
    void loadWorkspaces();
  }, [wsQuery, loadWorkspaces]);

  const loadDoc = useCallback(async (id: string) => {
    const response = await fetch(`/api/doc?${wsQuery({id})}`);

    if (!response.ok) {
      setStatus(
        response.status === 404 ? `${id} 不存在或已被删除` : `读取失败：${response.status}`,
      );
      return undefined;
    }

    const payload = (await response.json()) as Doc;
    setDoc(payload);
    setIncoming(undefined);
    setShowIncoming(false);
    setDrafts(current => {
      const next = {...current};
      delete next[id];
      return next;
    });
    return payload;
  }, [wsQuery]);

  const loadBacklinks = useCallback(async (id: string) => {
    const response = await fetch(`/api/backlinks?${wsQuery({id})}`);
    setBacklinks(response.ok ? ((await response.json()) as {docs: DocMeta[]}).docs : []);
  }, [wsQuery]);

  const loadGit = useCallback(async (options: {keepMessage?: boolean} = {}) => {
    const response = await fetch(`/api/git/status?${wsQuery()}`);

    if (!response.ok) {
      setGit(undefined);
      return undefined;
    }

    const payload = (await response.json()) as GitStatus;
    setGit(payload);

    if (!options.keepMessage) {
      setGitMessage(payload.message?.trim() || draftMessage(payload.changes));
    }

    return payload;
  }, [wsQuery]);

  const loadGitDiff = useCallback(async (file?: string, base: 'head' | 'index' = 'head') => {
    const query = file ? `?path=${encodeURIComponent(file)}` : '';
    const response = await fetch(`/api/git/diff?${wsQuery({...file ? {path: file} : {}, base})}`);

    if (!response.ok) {
      setGitDiffText('');
      setGitSides(undefined);
      return;
    }

    setGitDiffText(((await response.json()) as {diff: string}).diff);

    if (!file) {
      setGitSides(undefined);
      return;
    }

    const sides = await fetch(`/api/git/show?${wsQuery({path: file, ...(base === 'index' ? {base: 'index'} : {})})}`);
    setGitSides(
      sides.ok
        ? ((await sides.json()) as {original: string; modified: string})
        : undefined,
    );
  }, [wsQuery]);

  useEffect(() => {
    void loadDocs().then(list => {
      // 路由带工作区前缀（/w/<id>/changes），这里用结尾判断，否则深链接会被踢回文档。
      if (pathname.endsWith('/changes') || selected) {
        return;
      }

      const first = list.find(item => item.kind === 'source') ?? list[0];

      if (first) {
        navigate(docUrl(first.id), {replace: true});
      }
    });
    void loadGit();
  }, [loadDocs, loadGit, pathname, selected, navigate]);

  useEffect(() => {
    if (!selected) {
      return;
    }

    setStatus('');
    setIncoming(undefined);
    void loadDoc(selected);
    void loadBacklinks(selected);
  }, [selected, loadDoc, loadBacklinks]);

  // 这篇文档是被哪几段对话改出来的。
  useEffect(() => {
    if (!selected) {
      setProvenance([]);
      return;
    }

    let cancelled = false;
    setShowProvenance(false);

    void (async () => {
      const response = await fetch(`/api/conversations?${wsQuery({doc: selected})}`);

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as {conversations: ConversationRecord[]};

      if (!cancelled) {
        setProvenance(payload.conversations);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  /** 单个文档的 diff：以暂存区为基准，对比当前编辑器内容。 */
  const loadFileDiff = useCallback(async () => {
    if (!doc) {
      return;
    }

    const response = await fetch(`/api/git/show?${wsQuery({path: doc.relPath, base: 'index'})}`);

    if (!response.ok) {
      setStatus(`读不到 ${doc.relPath} 的已提交版本`);
      setFileDiff(undefined);
      return;
    }

    const payload = (await response.json()) as {original: string};
    setFileDiff({original: payload.original, modified: stateRef.current.draft});
  }, [doc, wsQuery]);

  useEffect(() => {
    if (diffMode === 'file') {
      void loadFileDiff();
    }
  }, [diffMode, loadFileDiff]);

  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);

    socket.onmessage = async event => {
      const change = JSON.parse(event.data as string) as
        | Change
        | {type: 'ready'}
        | {type: 'reload'};

      if (change.type === 'ready') {
        return;
      }

      if ('ws' in change && change.ws && workspaceId && change.ws !== workspaceId) {
        return;
      }

      if (change.type === 'reload') {
        // dev 模式下前端重新构建完成，直接刷新，省掉手动刷新。
        location.reload();
        return;
      }

      void loadDocs();
      void loadGit({keepMessage: true});
      const current = stateRef.current;

      if (change.id !== current.doc?.id || change.revision === current.doc.revision) {
        return;
      }

      const response = await fetch(`/api/doc?id=${encodeURIComponent(change.id)}`);

      if (!response.ok) {
        if (change.type === 'deleted') {
          // 正在看的文档被删掉了：不要继续显示旧内容。
          setDoc(undefined);
          setStatus(`${change.id} 已被删除`);
        } else {
          setStatus('文档读取失败');
        }

        return;
      }

      const fresh = (await response.json()) as Doc;
      const pending = pendingWriteRef.current;

      if (pending && pending.id === fresh.id && pending.body === fresh.body) {
        // 自己刚写的回声，不当作外部改动。
        pendingWriteRef.current = undefined;
        return;
      }

      if (current.draft === current.doc.body) {
        setDoc(fresh);
        setIncoming(undefined);
        setStatus('文档已被外部修改，已重新载入');
      } else {
        setIncoming({id: fresh.id, revision: fresh.revision, body: fresh.body});
        setStatus('磁盘上有新版本，你的草稿还没保存');
      }
    };

    return () => socket.close();
  }, [loadDocs]);

  useEffect(() => {
    if (gitOpen) {
      void loadGitDiff(gitFile, reviewBase);
    }
  }, [gitOpen, gitFile, loadGitDiff, reviewBase]);

  // 审阅页总是盯着一篇文档：没选或选中的文件已经不在改动里，就落到第一篇。
  useEffect(() => {
    if (!gitOpen) {
      autoPickedRef.current = false;
      return;
    }

    const list = git?.changes ?? [];

    if (list.length === 0) {
      setGitFile(undefined);
      return;
    }

    if (!autoPickedRef.current || !gitFile || !list.some(change => change.path === gitFile)) {
      autoPickedRef.current = true;
      setGitFile(list[0]!.path);
    }
  }, [gitFile, gitOpen, git]);

  const save = useCallback(async () => {
    const current = stateRef.current;

    if (!current.doc || current.draft === current.doc.body) {
      return;
    }

    setBusy(true);
    setStatus('保存中…', 'save');
    pendingWriteRef.current = {id: current.doc.id, body: current.draft};

    const response = await fetch(`/api/doc?${wsQuery({id: current.doc.id})}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: current.draft, baseRevision: current.doc.revision}),
    });

    const payload = (await response.json()) as {revision?: string; error?: {message: string}};
    setBusy(false);

    if (!response.ok) {
      pendingWriteRef.current = undefined;
      setStatus(`保存失败：${payload.error?.message ?? response.status}`, 'save');
      await loadDoc(current.doc.id);
      return;
    }

    setStatus('已保存', 'save');
    await loadDoc(current.doc.id);
    await loadDocs();
    await loadBacklinks(current.doc.id);
    await loadGit({keepMessage: true});
  }, [loadDoc, loadDocs, loadBacklinks]);

  useEffect(() => {
    const query = filter.trim();

    if (!query) {
      setHits(undefined);
      return;
    }

    const timer = setTimeout(async () => {
      const response = await fetch(`/api/search?${wsQuery({q: query})}`);

      if (response.ok) {
        setHits(((await response.json()) as {hits: SearchHit[]}).hits);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
        return;
      }

      if (event.key === 'Escape') {
        if (showIncoming) {
          setShowIncoming(false);
          return;
        }

        if (gitOpen) {
          if (selected) {
            openDoc(selected);
          } else {
            navigate(`/w/${workspaceId}/`);
          }

          return;
        }

        if (searchParams.get('diff') === '1' && selected) {
          navigate(docUrl(selected), {replace: true});
        }

        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.filter')?.focus();
        return;
      }

      const target = event.target as HTMLElement | null;

      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // 审阅页里方向键在文件之间移动，而不是切文档。
        if (gitOpen) {
          const files = git?.changes ?? [];
          const index = files.findIndex(change => change.path === gitFile);
          const next = files[index + (event.key === 'ArrowDown' ? 1 : -1)];

          if (next) {
            event.preventDefault();
            setGitFile(next.path);
          }

          return;
        }

        const index = flatDocs.findIndex(item => item.id === stateRef.current.selected);

        if (index === -1) {
          return;
        }

        const next = flatDocs[index + (event.key === 'ArrowDown' ? 1 : -1)];

        if (next) {
          event.preventDefault();
          openDoc(next.id);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save, flatDocs, gitOpen, selected, openDoc, navigate, searchParams, git, gitFile]);

  const cancelCreate = () => {
    setCreating(undefined);
    setCreatingFolder(undefined);
    setNewId('');
  };

  const createDoc = async (kind: DocKind) => {
    const base = creatingFolder ?? kind;
    const typed = newId.trim().replace(/\.md$/i, '');
    // 输入按入口算相对路径：在 source 下写「ui/button」就是 source/ui/button；
    // 写成完整 id（source/… 或 derived/…）也可以，不会被再拼一层。
    const id = /^(source|derived)\//.test(typed) ? typed : `${base}/${typed}`;

    if (!typed) {
      setStatus('先填一个 id');
      return;
    }

    setBusy(true);
    const response = await fetch(`/api/doc?${wsQuery({id})}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: `# ${id.split('/').pop()}\n\n`}),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json()) as {error?: {message: string}};
      setStatus(
        response.status === 400 && /已存在/.test(payload.error?.message ?? '')
          ? `已存在同名文档：${id}`
          : `创建失败：${payload.error?.message ?? response.status}`,
      );
      return;
    }

    cancelCreate();
    await loadDocs();
    // 新文档先展开它所在的目录，再进编辑器（而不是 diff）。
    setCollapsed(current => {
      const next = new Set(current);
      let prefix = '';

      for (const segment of id.split('/').slice(0, -1)) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        next.delete(prefix);
      }

      return next;
    });
    focusEditorRef.current = true;
    openDoc(id, {diff: false});
  };

  const removeDoc = async () => {
    if (!doc) {
      return;
    }

    setConfirmingDelete(false);
    setBusy(true);
    const response = await fetch(`/api/doc?${wsQuery({id: doc.id})}`, {method: 'DELETE'});
    setBusy(false);

    if (!response.ok) {
      setStatus(`删除失败：${response.status}`);
      return;
    }

    setStatus(`${doc.id} 已删除`);
    setDoc(undefined);
    const list = await loadDocs();
    const next = list.find(item => item.kind === 'source') ?? list[0];

    if (next) {
      openDoc(next.id, {diff: false});
    } else {
      navigate(`/w/${workspaceId}/`);
    }
  };

  const stage = async (path?: string, unstage = false) => {
    setGitBusy(true);

    const response = await fetch('/api/git/stage', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...(path ? {path} : {}), ...(unstage ? {unstage: true} : {})}),
    });

    setGitBusy(false);

    if (!response.ok) {
      setStatus(unstage ? '取消暂存失败' : '暂存失败');
      return;
    }

    setGit((await response.json()) as GitStatus);
    await loadGitDiff(gitFile);

    // 文档页的 diff 以暂存区为基准，暂存之后它得跟着变。
    if (diffMode === 'file') {
      await loadFileDiff();
    }
  };

  const commit = async () => {
    setGitBusy(true);

    const response = await fetch('/api/git/commit', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({message: gitMessage}),
    });

    const payload = (await response.json()) as {ok?: boolean; sha?: string; error?: string};
    setGitBusy(false);

    if (!response.ok || !payload.ok) {
      setStatus(`提交失败：${payload.error ?? response.status}`);
      return;
    }

    setStatus(`已提交 ${payload.sha}`);
    setGitMessage('');
    setGitFile(undefined);
    await loadGit();
    await loadGitDiff(undefined);
    await loadDocs();

    // 提交完没什么可审的了，回到刚才那篇文档。
    if (selected) {
      openDoc(selected);
    } else {
      navigate(`/w/${workspaceId}/`);
    }
  };

  const statusLabel = (change: GitChange): string => {
    const code = change.index !== ' ' && change.index !== '?' ? change.index : change.worktree;

    switch (code) {
      case '?':
      case 'A':
        return '新增';
      case 'M':
        return '修改';
      case 'D':
        return '删除';
      case 'R':
        return '改名';
      default:
        return code;
    }
  };

  const titleOf = useMemo(() => {
    const map = new Map(docs.map(item => [item.id, item.title]));
    return (id: string) => map.get(id) ?? id;
  }, [docs]);

  const diff = useMemo(() => {
    if (!doc || !diffMode) {
      return undefined;
    }

    if (diffMode === 'file') {
      if (!fileDiff) {
        return undefined;
      }

      const lines = diffLines(fileDiff.original, fileDiff.modified);
      return {
        original: fileDiff.original,
        modified: fileDiff.modified,
        summary: summarizeDiff(lines),
        caption: diffCaption,
      };
    }

    if (!incoming) {
      return undefined;
    }

    const lines = diffLines(draft, incoming.body);
    return {
      original: draft,
      modified: incoming.body,
      summary: summarizeDiff(lines),
      caption: '磁盘上的新版本与你的草稿的差异',
    };
  }, [doc, draft, diffMode, incoming, fileDiff, diffCaption]);

  const openLink = (id: string) => {
    if (docs.some(item => item.id === id)) {
      selectDoc(id);
      return;
    }

    setStatus(`链接目标不在项目里：${id}`);
  };

  /** 打开文档：有改动就先进 diff，没有就直接进编辑器。 */
  const selectDoc = (id: string) => {
    const target = docs.find(item => item.id === id);
    const hasGitChange = target ? changeByPath.has(target.relPath) : false;
    openDoc(id, {diff: !hasDraft(id) && hasGitChange});
  };

  const onContentClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');

    if (!anchor || !doc) {
      return;
    }

    const href = anchor.getAttribute('href') ?? '';

    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      return;
    }

    event.preventDefault();
    const id = resolveDocId(href, doc.id);

    if (!id) {
      setStatus(`无法解析链接：${href}`);
      return;
    }

    openLink(id);
  };

  const visible = (kind: DocKind) =>
    docs
      .filter(item => item.kind === kind)
      .filter(item => {
        const needle = filter.trim().toLowerCase();

        if (!needle) {
          return true;
        }

        return item.title.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle);
      });

  const toggleFolder = (path: string) => {
    setCollapsed(current => {
      const next = new Set(current);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  };

  const renderNode = (node: TreeNode) => {
    const isRoot = node.depth === 0;
    /**
     * 文件文字要和所属文件夹的标签对齐：标签前面有个箭头（0.45rem）加间隔（0.4rem），
     * 再减掉文件行自己的 2px 左边框。根级文件因此对齐 SOURCE / DERIVED，嵌套的也一样对齐。
     */
    const folderIndent = (depth: number) => (depth === 0 ? 0.35 : 1.2 + (depth - 1) * 1.15);
    const indent = {
      // 文件夹行按层级缩进；文件行对齐所属文件夹的标签文字。
      paddingLeft: node.doc
        ? `calc(${folderIndent(node.depth - 1) + 0.85}rem - 2px)`
        : `${folderIndent(node.depth)}rem`,
    };

    if (!node.doc) {
      const open = !collapsed.has(node.path);
      const label = node.name;

      return (
        <li className={isRoot ? 'tree-root' : 'tree-folder'} key={node.path}>
          <div className={`folder-row layer-${node.kind}`} style={indent}>
            <button className="folder" onClick={() => toggleFolder(node.path)} type="button">
              <span className={`chev${open ? '' : ' collapsed'}`}>▾</span>
              <span className="folder-name">{label}</span>
              {isRoot && <span className="count">{countDocs(node)}</span>}
            </button>
            <button
              className="ghost"
              onClick={() => {
                setCreating(node.name as DocKind);
                setCreatingFolder(node.path);
                setNewId('');
              }}
              title={`在 ${node.path}/ 下新建文档`}
              type="button"
            >
              <Plus size={12} />
            </button>
          </div>
          {creatingFolder === node.path && (
            <form
              className="create"
              onSubmit={event => {
                event.preventDefault();
                void createDoc(node.name as DocKind);
              }}
              style={{paddingLeft: `${node.depth === 0 ? 1.1 : 0.86 + node.depth * 1.15}rem`}}
            >
              <input
                autoFocus
                placeholder="文件名"
                value={newId}
                onChange={event => setNewId(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    cancelCreate();
                  }
                }}
              />
              <button aria-label="创建" disabled={busy} title="创建（回车）" type="submit">
                <Check size={13} />
              </button>
            </form>
          )}
          {open && node.children.length > 0 && <ul>{node.children.map(renderNode)}</ul>}
        </li>
      );
    }

    const change = changeByPath.get(node.doc.relPath);
    const badge = change ? statusLabel(change) : undefined;

    return (
      <li key={node.path}>
        <button
          className={`doc layer-${node.doc.kind}${node.doc.id === selected ? ' active' : ''}`}
          onClick={() => selectDoc(node.doc!.id)}
          style={indent}
          type="button"
        >
          <span className="file">
            {fileName(node.doc.id)}
            <span className="marks">
              {hasDraft(node.doc.id) && <span className="dot" title="有未保存的草稿" />}
              {change?.added !== undefined ? (
                <span className="delta" title={`${statusLabel(change)}：未提交`}>
                  <span className="add">+{change.added}</span>
                  <span className="remove">−{change.removed ?? 0}</span>
                </span>
              ) : badge ? (
                <span className={`badge ${change!.worktree}`} title="有未提交的改动">
                  {badge}
                </span>
              ) : null}
            </span>
          </span>
          <span className="title">{node.doc.title}</span>
        </button>
      </li>
    );
  };

  const countDocs = (node: TreeNode): number =>
    node.doc ? 1 : node.children.reduce((sum, child) => sum + countDocs(child), 0);

  /** 路径太长时留尾部的完整层级——工作区靠目录名区分，截头比截尾有用。 */
  const shortenPath = (path: string, max = 26) => {
    if (path.length <= max) {
      return path;
    }

    const parts = path.split('/').filter(Boolean);
    let tail = '';

    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index] ?? '';
      const next = tail ? `${part}/${tail}` : part;

      if (tail && next.length + 1 > max) {
        break;
      }

      tail = next;
    }

    return `…/${tail}`;
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="pick-wrap">
            <button
              aria-expanded={switcherOpen}
              className={`workspace-pick${switcherOpen ? ' open' : ''}`}
              onClick={() => {
                setSwitcherOpen(value => !value);
                void loadWorkspaces();
              }}
              title={
                workspace
                  ? `项目根　${workspace.root}\n文档目录　${workspace.docs}`
                  : ''
              }
              type="button"
            >
              <span className="pick-kicker">工作区</span>
              <span className="pick-row">
                <span className="workspace-name">{workspace?.name ?? '…'}</span>
                <ChevronDown className="pick-chevron" size={12} />
              </span>
            </button>
            {switcherOpen && (
              <>
                <div className="switcher-backdrop" onClick={() => setSwitcherOpen(false)} />
                <div aria-label="切换工作区" className="switcher" role="dialog">
                  <p className="switcher-head">
                    <span>切换到</span>
                    <span className="switcher-count">{workspaceList.length}</span>
                  </p>
                  <ul className="switcher-list">
                    {workspaceList.map(item => (
                      <li key={item.id}>
                        <button
                          className={`switcher-item${item.id === workspaceId ? ' current' : ''}`}
                          onClick={() => {
                            setSwitcherOpen(false);

                            if (item.id === workspaceId) {
                              return;
                            }

                            navigate(`/w/${item.id}/`);
                          }}
                          title={`项目根　${item.root}\n文档目录　${item.docs}`}
                          type="button"
                        >
                          <span className="switcher-text">
                            <span className="switcher-name">{item.name}</span>
                            {/* 列的是文档目录：工作区之间真正的差别在这里。 */}
                            <span className="switcher-path">{shortenPath(item.docs)}</span>
                          </span>
                          {item.id === workspaceId ? (
                            <Check className="switcher-check" size={13} />
                          ) : (
                            <span className="switcher-go">切换</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {workspaceList.length === 0 && (
                    <p className="switcher-empty">还没有记录过任何工作区</p>
                  )}
                  <form
                    className="switcher-add"
                    onSubmit={event => {
                      event.preventDefault();
                      void (async () => {
                        const response = await fetch('/api/workspaces', {
                          method: 'POST',
                          headers: {'content-type': 'application/json'},
                          body: JSON.stringify({
                            root: newWorkspace.trim(),
                            docs: newDocs.trim(),
                          }),
                        });
                        const payload = (await response.json()) as {
                          workspace?: {id: string};
                          error?: {message: string};
                        };

                        if (!response.ok || !payload.workspace) {
                          setStatus(`添加失败：${payload.error?.message ?? response.status}`);
                          return;
                        }

                        setNewWorkspace('');
                        setNewDocs('');
                        setSwitcherOpen(false);
                        await loadWorkspaces();
                        navigate(`/w/${payload.workspace.id}/`);
                      })();
                    }}
                  >
                    <label className="add-row">
                      <span className="add-label">项目目录</span>
                      <input
                        onChange={event => setNewWorkspace(event.target.value)}
                        placeholder="项目目录"
                        value={newWorkspace}
                      />
                    </label>
                    <label className="add-row">
                      <span className="add-label">文档目录</span>
                      <input
                        onChange={event => setNewDocs(event.target.value)}
                        placeholder={DEFAULT_DOCS_DIR}
                        value={newDocs}
                      />
                    </label>
                    <div className="add-foot">
                      <button aria-label="添加工作区" title="添加工作区" type="submit">
                        <Plus size={14} />
                        添加
                      </button>
                    </div>
                  </form>
                </div>
              </>
            )}
          </div>
          <input
            className="filter"
            placeholder="过滤…"
            value={filter}
            onChange={event => setFilter(event.target.value)}
          />
        </div>
        {git?.available && git.changes.length > 0 && (
          <button className="review-cue" onClick={() => navigate(`/w/${workspaceId}/changes`)} type="button">
            <GitCommitHorizontal size={12} />
            {git.changes.length} 篇未提交
            <span className="cue-action">审阅</span>
          </button>
        )}
        {hits ? (
          <section className="results">
            <p className="results-head">
              <span>搜索结果</span>
              <span className="count">{hits.length}</span>
            </p>
            <ul className="hits">
              {hits.map(hit => (
                <li key={hit.id}>
                  <button
                    className={hit.id === selected ? 'active' : ''}
                    onClick={() => selectDoc(hit.id)}
                    type="button"
                  >
                    <span className="hit-title">{hit.title}</span>
                    <span className="hit-snippet">{hit.snippet}</span>
                  </button>
                </li>
              ))}
              {hits.length === 0 && <li className="empty">没有命中</li>}
            </ul>
          </section>
        ) : (
          <ul className="tree">
            {tree.map(renderNode)}
            {tree.length === 0 && <li className="empty">暂无文档</li>}
          </ul>
        )}
      </aside>
      <main className="main">
        {gitOpen && (
          <section className="git pane pane-review">
            <header>
              <div>
                <h2>审阅改动</h2>
                <p className="meta">
                  {git?.branch ? `分支 ${git.branch} · ` : ''}
                  {git ? `${git.changes.length} 个文件` : ''} · 只提交 source/ 与 derived/
                </p>
                {git && git.otherChanges > 0 && (
                  <p className="meta hint">
                    另有 {git.otherChanges} 个非文档条目（代码等）未提交，不归这个工具管
                  </p>
                )}
              </div>
              <div className="actions">
                {git && git.changes.length > 0 && (
                  <button
                    className="stage-button"
                    onClick={() => void stage()}
                    title="把两层文档的改动全部暂存"
                    type="button"
                  >
                    全部暂存
                  </button>
                )}
                <button
                  onClick={() => (selected ? openDoc(selected) : navigate(`/w/${workspaceId}/`))}
                  title="回到文档"
                  type="button"
                >
                  <X size={14} />
                  关闭
                </button>
              </div>
            </header>
            {!git?.available ? (
              <p className="meta git-fallback">{git?.reason ?? '拿不到 git 状态'}</p>
            ) : (
              <>
                <div className="git-body">
                  <ul className="git-files">
                    <li className="git-files-head">
                      <span className="git-files-count">{git.changes.length} 个文件</span>
                      <div className="segmented" role="group" aria-label="diff 基准">
                        <button
                          className={reviewBase === 'head' ? 'on' : ''}
                          onClick={() => setReviewBase('head')}
                          title="与已提交版本比较"
                          type="button"
                        >
                          HEAD
                        </button>
                        <button
                          className={reviewBase === 'index' ? 'on' : ''}
                          onClick={() => setReviewBase('index')}
                          title="与暂存区比较"
                          type="button"
                        >
                          暂存区
                        </button>
                      </div>
                    </li>
                    {git.changes.map(change => (
                      <li key={change.path}>
                        <div
                          className={`git-row layer-${change.path.startsWith('source/') ? 'source' : 'derived'}${
                            gitFile === change.path ? ' active' : ''
                          }`}
                        >
                          <button
                            className="git-pick"
                            onClick={() => setGitFile(change.path)}
                            type="button"
                          >
                            <span className="path">{change.path}</span>
                            {change.added !== undefined && (
                              <span
                                className={`stat${change.index !== ' ' && change.index !== '?' ? ' staged' : ''}`}
                                title={statusLabel(change)}
                              >
                                <span className="add">+{change.added}</span>{' '}
                                <span className="remove">−{change.removed ?? 0}</span>
                              </span>
                            )}
                          </button>
                          {hasUnstaged(change) && (
                            <button
                              className="git-stage"
                              onClick={() => void stage(change.path)}
                              title="暂存这个文件"
                              type="button"
                            >
                              <Plus size={12} />
                            </button>
                          )}
                          {isStaged(change) && (
                            <button
                              className="git-stage"
                              onClick={() => void stage(change.path, true)}
                              title="取消暂存"
                              type="button"
                            >
                              <Minus size={12} />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                    {git.changes.length === 0 && <li className="empty">没有未提交的文档改动</li>}
                  </ul>
                  <div className="git-diff">
                    {gitSides ? (
                      <MarkdownDiff
                        modified={gitSides.modified}
                        onPick={gitFile ? recordPick : undefined}
                        original={gitSides.original}
                      />
                    ) : (
                      <pre>
                        {parseGitDiff(gitDiffText).map((line, index) => (
                          <div className={`line ${line.type}`} key={index}>
                            <span className="sign">
                              {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
                            </span>
                            <span>{line.text}</span>
                          </div>
                        ))}
                      </pre>
                    )}
                  </div>
                </div>
                <div className="git-commit">
                  <textarea
                    placeholder="commit message（提交前可以改）"
                    value={gitMessage}
                    onChange={event => setGitMessage(event.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={gitBusy || commitCount === 0}
                    onClick={() => void commit()}
                    title={
                      stagedCount > 0
                        ? `只提交已暂存的 ${stagedCount} 篇`
                        : `把 ${commitCount} 篇文档的改动一起提交`
                    }
                    type="button"
                  >
                    提交 {commitCount} 个
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {!gitOpen && doc ? (
          <div className="pane">
            <header>
              <div>
                <h2 className="doc-title">{doc.title}</h2>
                <p className="meta">
                  {doc.id} · {doc.revision}
                  {dirty && <span className="dirty">未保存</span>}
                </p>
              </div>
              <div className="actions">
                {git?.available && (
                  <button
                    onClick={() =>
                      gitOpen && selected ? openDoc(selected) : navigate(`/w/${workspaceId}/changes`)
                    }
                    title="待提交的文档改动"
                    type="button"
                  >
                    <GitCommitHorizontal size={14} />
                    {gitOpen ? '回到文档' : `变更 ${git.changes.length}`}
                  </button>
                )}
                {(dirty || changeByPath.has(doc.relPath)) && (
                  <button
                    onClick={() => openDoc(doc.id, {diff: diffMode !== 'file'})}
                    title={diffMode === 'file' ? '回到编辑' : diffTitle}
                    type="button"
                  >
                    <Columns2 size={14} />
                    {diffMode === 'file' ? '编辑' : '对比'}
                  </button>
                )}
                <button onClick={() => void loadDoc(doc.id)} title="丢弃草稿并重新读取" type="button">
                  <RotateCw size={14} />
                  重新载入
                </button>
                {docChange && hasUnstaged(docChange) && (
                  <button
                    className="stage-button"
                    disabled={gitBusy}
                    onClick={() => void stage(doc.relPath)}
                    title="把这篇的改动放进暂存区，之后在审阅页提交"
                    type="button"
                  >
                    <Plus size={14} />
                    暂存
                  </button>
                )}
                {docChange && isStaged(docChange) && (
                  <button
                    disabled={gitBusy}
                    onClick={() => void stage(doc.relPath, true)}
                    title="把这篇从暂存区拿下来，改动留在工作区"
                    type="button"
                  >
                    <Minus size={14} />
                    取消暂存
                  </button>
                )}
                <button
                  className="primary"
                  disabled={!dirty || busy}
                  onClick={() => void save()}
                  title="保存（⌘S）"
                  type="button"
                >
                  <Check size={14} />
                  保存
                </button>
                <button
                  className="danger"
                  onClick={() => setConfirmingDelete(true)}
                  title="删除这篇文档"
                  type="button"
                >
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </header>

            {incoming && (
              <div className="banner">
                <span>磁盘上出现了新版本。</span>
                <button
                  onClick={() => setShowIncoming(value => !value)}
                  type="button"
                >
                  {showIncoming ? '回到草稿' : '看差异'}
                </button>
                <button
                  onClick={() => {
                    setDrafts(current => {
                      const next = {...current};
                      delete next[incoming.id];
                      return next;
                    });
                    setDoc({...doc, body: incoming.body, revision: incoming.revision});
                    setIncoming(undefined);
                    setShowIncoming(false);
                    setStatus('已载入磁盘版本，草稿丢弃');
                  }}
                  type="button"
                >
                  用磁盘版本
                </button>
              </div>
            )}

            {confirmingDelete && (
              <div className="banner danger">
                <span>
                  删除 <code>{doc.relPath}</code>？
                </span>
                <button onClick={() => void removeDoc()} type="button">
                  确认删除
                </button>
                <button onClick={() => setConfirmingDelete(false)} type="button">
                  取消
                </button>
              </div>
            )}

            <div className="relations">
              <span className="label">引用</span>
              {doc.links.length === 0 && <span className="empty">无</span>}
              {doc.links.map(id => (
                <button key={id} onClick={() => openLink(id)} type="button">
                  {titleOf(id)}
                </button>
              ))}
              <span className="label">被引用</span>
              {backlinks.length === 0 && <span className="empty">无</span>}
              {backlinks.map(item => (
                <button key={item.id} onClick={() => openLink(item.id)} type="button">
                  {item.title}
                </button>
              ))}
              {provenance.length > 0 && (
                <>
                  <span className="label">来源</span>
                  <button onClick={() => setShowProvenance(value => !value)} type="button">
                    {showProvenance ? '收起' : `${provenance.length} 段对话`}
                  </button>
                </>
              )}
            </div>

            {showProvenance && (
              <ol className="provenance">
                {provenance.map((record, index) => (
                  <li key={`${record.sessionId}-${record.at}`}>
                    <div className="provenance-head">
                      <span className="when">{formatTime(record.at)}</span>
                      <span className="channel">{record.channel}</span>
                      <span className="turn">{record.turnId?.slice(0, 8) ?? record.sessionId.slice(0, 8)}</span>
                    </div>
                    <p className="said">{record.text}</p>
                    <p className="meta">
                      {record.captures.some(capture => capture.thinking)
                        ? `思考：${record.captures.find(capture => capture.thinking)?.thinking}`
                        : '没有留下思考产物'}
                    </p>
                    {index === provenance.length - 1 && null}
                  </li>
                ))}
              </ol>
            )}

            {diff ? (
              <section className="diff">
                <div className="diff-head">
                  <span>{diff.caption}</span>
                  <span className="stat">
                    <span className="add">+{diff.summary.added}</span>{' '}
                    <span className="remove">−{diff.summary.removed}</span>
                  </span>
                  <button onClick={() => openDoc(doc.id)} type="button">
                    关闭
                  </button>
                </div>
                <MarkdownDiff
                  modified={diff.modified}
                  onChange={value => setDrafts(current => ({...current, [doc.id]: value}))}
                  onPick={recordPick}
                  original={diff.original}
                />
              </section>
            ) : (
              <MarkdownEditor
                autoFocus={focusEditorRef.current}
                onChange={value => setDrafts(current => ({...current, [doc.id]: value}))}
                onPick={recordPick}
                value={draft}
              />
            )}
          </div>
        ) : !gitOpen ? (
          <div className="placeholder">
            <p>{missingDoc ? `找不到这篇文档：${selected}` : docs.length === 0 ? '还没有任何文档。点左侧 source 的 ＋，写下第一条决定。' : '左侧选一篇文档开始。'}</p>
            {missingDoc && (
              <button
                className="placeholder-action"
                onClick={() => {
                  const first = docs.find(item => item.kind === 'source') ?? docs[0];

                  if (first) {
                    openDoc(first.id);
                  }
                }}
                type="button"
              >
                回到第一篇
              </button>
            )}
            <div className="keys">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> 切换文档
              </span>
              <span>
                <kbd>⌘K</kbd> 搜索
              </span>
              <span>
                <kbd>⌘S</kbd> 保存
              </span>
              <span>
                <kbd>Esc</kbd> 关闭 diff
              </span>
            </div>
          </div>
        ) : null}
      </main>
      <div className="toasts">
        {toasts.map(toast => (
          <div className={`toast ${toast.kind}`} key={toast.id}>
            {toast.kind !== 'info' && (
              <span className="icon">
                {toast.kind === 'ok' ? <Check size={13} /> : <AlertTriangle size={13} />}
              </span>
            )}
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
