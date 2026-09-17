import MarkdownIt from 'markdown-it';
import {
  AlertTriangle,
  Check,
  Columns2,
  GitCommitHorizontal,
  Plus,
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
import {resolveDocId} from '../core/links.ts';
import {MarkdownDiff, MarkdownEditor} from './editors.tsx';

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

      return a.name.localeCompare(b.name);
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

export function App() {
  return (
    <Routes>
      <Route element={<Workspace />} path="/" />
      <Route element={<Workspace />} path="/d/*" />
      <Route element={<Workspace />} path="/changes" />
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
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
  const [gitMessage, setGitMessage] = useState('');
  const [gitBusy, setGitBusy] = useState(false);

  // 路由即状态：/d/<id> 看文档，?diff=1 看改动，/changes 看提交面板。
  const navigate = useNavigate();
  const params = useParams();
  const {pathname} = useLocation();
  const [searchParams] = useSearchParams();
  const selected = params['*'] ? decodeURIComponent(params['*']) : undefined;
  const gitOpen = pathname.startsWith('/changes');
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
      navigate(`/d/${id}${options.diff ? '?diff=1' : ''}`);
    },
    [navigate],
  );

  const draft = selected ? drafts[selected] ?? doc?.body ?? '' : '';
  const dirty = doc !== undefined && draft !== doc.body;

  const stateRef = useRef({doc, draft, selected});
  const pendingWriteRef = useRef<{id: string; body: string} | undefined>(undefined);
  const focusEditorRef = useRef(false);
  const autoPickedRef = useRef(false);
  stateRef.current = {doc, draft, selected};

  const notify = useCallback((text: string) => {
    if (!text) {
      return;
    }

    const kind: Toast['kind'] = /失败|错误|无法|不在/.test(text)
      ? 'error'
      : /已保存|已提交|已删除|已载入|生效/.test(text)
        ? 'ok'
        : 'info';
    const id = Date.now() + Math.random();

    setToasts(current => [...current.slice(-2), {id, kind, text}]);
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), 3200);
  }, []);

  const setStatus = notify;

  const changeByPath = useMemo(
    () => new Map((git?.changes ?? []).map(change => [change.path, change])),
    [git],
  );

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
    const response = await fetch('/api/docs');
    const payload = (await response.json()) as {docs: DocMeta[]};
    setDocs(payload.docs);
    return payload.docs;
  }, []);

  const loadDoc = useCallback(async (id: string) => {
    const response = await fetch(`/api/doc?id=${encodeURIComponent(id)}`);

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
  }, []);

  const loadBacklinks = useCallback(async (id: string) => {
    const response = await fetch(`/api/backlinks?id=${encodeURIComponent(id)}`);
    setBacklinks(response.ok ? ((await response.json()) as {docs: DocMeta[]}).docs : []);
  }, []);

  const loadGit = useCallback(async (options: {keepMessage?: boolean} = {}) => {
    const response = await fetch('/api/git/status');

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
  }, []);

  const loadGitDiff = useCallback(async (file?: string) => {
    const query = file ? `?path=${encodeURIComponent(file)}` : '';
    const response = await fetch(`/api/git/diff${query}`);

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

    const sides = await fetch(`/api/git/show?path=${encodeURIComponent(file)}`);
    setGitSides(
      sides.ok
        ? ((await sides.json()) as {original: string; modified: string})
        : undefined,
    );
  }, []);

  useEffect(() => {
    void loadDocs().then(list => {
      if (pathname.startsWith('/changes') || selected) {
        return;
      }

      const first = list.find(item => item.kind === 'source') ?? list[0];

      if (first) {
        navigate(`/d/${first.id}`, {replace: true});
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

  // 单个文档的 diff：以已提交版本为基准，对比当前编辑器内容。
  useEffect(() => {
    if (diffMode !== 'file' || !doc) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const response = await fetch(`/api/git/show?path=${encodeURIComponent(doc.relPath)}`);

      if (!response.ok) {
        if (!cancelled) {
          setStatus(`读不到 ${doc.relPath} 的已提交版本`);
          setFileDiff(undefined);
        }

        return;
      }

      const payload = (await response.json()) as {original: string};

      if (!cancelled) {
        setFileDiff({original: payload.original, modified: stateRef.current.draft});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [diffMode, doc, loadGit]);

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
      void loadGitDiff(gitFile);
    }
  }, [gitOpen, gitFile, loadGitDiff]);

  // 每次进审阅页默认选中第一个文件（只看一次），而不是让用户先面对一份混合 diff。
  useEffect(() => {
    if (!gitOpen) {
      autoPickedRef.current = false;
      return;
    }

    if (!autoPickedRef.current && git && git.changes.length > 0) {
      autoPickedRef.current = true;
      setGitFile(git.changes[0]!.path);
    }
  }, [gitOpen, git]);

  const save = useCallback(async () => {
    const current = stateRef.current;

    if (!current.doc || current.draft === current.doc.body) {
      return;
    }

    setBusy(true);
    setStatus('保存中…');
    pendingWriteRef.current = {id: current.doc.id, body: current.draft};

    const response = await fetch(`/api/doc?id=${encodeURIComponent(current.doc.id)}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: current.draft, baseRevision: current.doc.revision}),
    });

    const payload = (await response.json()) as {revision?: string; error?: {message: string}};
    setBusy(false);

    if (!response.ok) {
      pendingWriteRef.current = undefined;
      setStatus(`保存失败：${payload.error?.message ?? response.status}`);
      await loadDoc(current.doc.id);
      return;
    }

    setStatus('已保存');
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
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);

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
            navigate('/');
          }

          return;
        }

        if (searchParams.get('diff') === '1' && selected) {
          navigate(`/d/${selected}`, {replace: true});
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
    const id = newId.trim().replace(/\.md$/i, '');
    const fullId = id.includes('/') ? id : `${base}/${id}`;

    if (!id) {
      setStatus('先填一个 id');
      return;
    }

    setBusy(true);
    const response = await fetch(`/api/doc?id=${encodeURIComponent(fullId)}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: `# ${id.split('/').pop()}\n\n`}),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json()) as {error?: {message: string}};
      setStatus(
        response.status === 400 && /已存在/.test(payload.error?.message ?? '')
          ? `已存在同名文档：${fullId}`
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

      for (const segment of fullId.split('/').slice(0, -1)) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        next.delete(prefix);
      }

      return next;
    });
    focusEditorRef.current = true;
    openDoc(fullId, {diff: false});
  };

  const removeDoc = async () => {
    if (!doc) {
      return;
    }

    setConfirmingDelete(false);
    setBusy(true);
    const response = await fetch(`/api/doc?id=${encodeURIComponent(doc.id)}`, {method: 'DELETE'});
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
      navigate('/');
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
      navigate('/');
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
        caption: '与上次提交的版本对比',
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
  }, [doc, draft, diffMode, incoming, fileDiff]);

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
    const hasDraft = drafts[id] !== undefined;
    const hasGitChange = target ? changeByPath.has(target.relPath) : false;
    openDoc(id, {diff: !hasDraft && hasGitChange});
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
    const indent = {paddingLeft: `${0.35 + node.depth * 1.15}rem`};

    if (!node.doc) {
      const open = !collapsed.has(node.path);
      const label =
        isRoot
          ? node.name === 'source'
            ? 'source · 你的决定'
            : 'derived · agent 维护'
          : node.name;

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
              style={{paddingLeft: `${1.1 + node.depth * 1.15}rem`}}
            >
              <input
                autoFocus
                placeholder={`${node.path}/新文档`}
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
              {drafts[node.doc.id] !== undefined && <span className="dot" title="有未保存的草稿" />}
              {badge && (
                <span className={`badge ${change!.worktree}`} title="有未提交的改动">
                  {badge}
                </span>
              )}
            </span>
          </span>
          <span className="title">{node.doc.title}</span>
        </button>
      </li>
    );
  };

  const countDocs = (node: TreeNode): number =>
    node.doc ? 1 : node.children.reduce((sum, child) => sum + countDocs(child), 0);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <h1>derivedoc</h1>
          <input
            className="filter"
            placeholder="过滤…"
            value={filter}
            onChange={event => setFilter(event.target.value)}
          />
        </div>
        {git?.available && git.changes.length > 0 && (
          <button className="review-cue" onClick={() => navigate('/changes')} type="button">
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
              </div>
              <div className="actions">
                <button
                  onClick={() => (selected ? openDoc(selected) : navigate('/'))}
                  title="回到文档"
                  type="button"
                >
                  <X size={14} />
                  关闭
                </button>
              </div>
            </header>
            {!git?.available ? (
              <p className="meta">{git?.reason ?? '拿不到 git 状态'}</p>
            ) : (
              <>
                <div className="git-body">
                  <ul className="git-files">
                    <li>
                      <button
                        className={gitFile === undefined ? 'active' : ''}
                        onClick={() => setGitFile(undefined)}
                        type="button"
                      >
                        <span className="badge">全部</span>
                        <span className="path">{git.changes.length} 个文件</span>
                      </button>
                    </li>
                    {git.changes.map(change => (
                      <li key={change.path}>
                        <button
                          className={gitFile === change.path ? 'active' : ''}
                          onClick={() => setGitFile(change.path)}
                          type="button"
                        >
                          <span className="badge">{statusLabel(change)}</span>
                          <span className="path">{change.path}</span>
                          {change.added !== undefined && (
                            <span className="stat">
                              <span className="add">+{change.added}</span>{' '}
                              <span className="remove">−{change.removed ?? 0}</span>
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    {git.changes.length === 0 && <li className="empty">没有未提交的文档改动</li>}
                  </ul>
                  <div className="git-diff">
                    {gitSides ? (
                      <MarkdownDiff
                        modified={gitSides.modified}
                        modifiedLabel="工作区"
                        original={gitSides.original}
                        originalLabel="已提交版本"
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
                    disabled={gitBusy || git.changes.length === 0}
                    onClick={() => void commit()}
                    type="button"
                  >
                    提交
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
                    onClick={() => (gitOpen && selected ? openDoc(selected) : navigate('/changes'))}
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
                    title={diffMode === 'file' ? '回到编辑' : '看相对上次提交的改动'}
                    type="button"
                  >
                    <Columns2 size={14} />
                    {diffMode === 'file' ? '编辑' : 'diff'}
                  </button>
                )}
                <button onClick={() => void loadDoc(doc.id)} title="丢弃草稿并重新读取" type="button">
                  <RotateCw size={14} />
                  重新载入
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
            </div>

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
                  original={diff.original}
                  originalLabel="原内容"
                  modifiedLabel="新内容"
                />
              </section>
            ) : (
              <MarkdownEditor
                autoFocus={focusEditorRef.current}
                onChange={value => setDrafts(current => ({...current, [doc.id]: value}))}
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
            <span className="icon">
              {toast.kind === 'ok' ? (
                <Check size={13} />
              ) : toast.kind === 'error' || toast.kind === 'warn' ? (
                <AlertTriangle size={13} />
              ) : null}
            </span>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
