import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitCommitHorizontal,
  Plus,
} from 'lucide-react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';

import {diffLines, summarizeDiff} from '../core/diff.ts';
import {DEFAULT_DOCS_DIR} from '../core/defaults.ts';
import {api, messageOf} from './api.ts';
import {DocPane} from './components/DocPane.tsx';
import {ReviewPane} from './components/ReviewPane.tsx';
import {docModelKey} from './editor-models.ts';
import {useDocSession} from './hooks/useDocSession.ts';
import {useDocDiff} from './hooks/useDocDiff.ts';
import {useDocs} from './hooks/useDocs.ts';
import {useGitReview} from './hooks/useGitReview.ts';
import {useToasts} from './hooks/useToasts.ts';
import {useWorkspaces} from './hooks/useWorkspaces.ts';
import type {Pick} from './editors.tsx';
import {shortenPath, statusLabel} from './format.ts';
import {countDocs, fileName, type TreeNode} from './tree.ts';
import {isStaged, type Change, type DocKind} from './types.ts';

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
      const defaultId = await api.defaultWorkspace().catch(() => undefined);

      if (defaultId) {
        navigate(`/w/${defaultId}/`, {replace: true});
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
  const [filter, setFilter] = useState('');
  const [, setCreating] = useState<DocKind>();
  const [creatingFolder, setCreatingFolder] = useState<string>();
  const [newId, setNewId] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newDocs, setNewDocs] = useState('');

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
  const docUrl = useCallback(
    (id: string, options: {diff?: boolean} = {}) =>
      `/w/${workspaceId}/d/${id}${options.diff ? '?diff=1' : ''}`,
    [workspaceId],
  );
  const {toasts, notify} = useToasts();
  const setStatus = notify;

  const {docs, tree, flatDocs, hits, loadDocs} = useDocs(workspaceId, filter);
  const {workspace, workspaces, loadWorkspaces} = useWorkspaces(workspaceId);

  const gitReview = useGitReview(workspaceId, {
    review: gitOpen,
    notify,
    onCommitted: async () => {
      await loadDocs();
    },
  });

  const {
    status: git,
    file: gitFile,
    setFile: setGitFile,
    changeByPath,
    loadGit,
    stage,
  } = gitReview;

  const session = useDocSession(workspaceId, selected, {
    notify,
    onSaved: async () => {
      await loadDocs();
      await loadGit({keepMessage: true});
    },
    onRemoved: async () => {
      const list = await loadDocs();
      const next = list.find(item => item.kind === 'source') ?? list[0];
      navigate(next ? docUrl(next.id, {diff: false}) : `/w/${workspaceId}/`);
    },
  });

  const {
    doc,
    draft,
    hasDraft,
    incoming,
    showIncoming,
    setShowIncoming,
    setIncoming,
    busy,
    loadDoc,
    applyExternal,
    save,
    createDoc: createDocInStore,
  } = session;

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
    [navigate, docUrl, setIncoming, setShowIncoming],
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
          void api.clearSelection(workspaceId).catch(() => undefined);
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

          await api
            .putSelection(workspaceId, {
              doc: id,
              from: pick.from,
              to: pick.to,
              quote: pick.text,
              ...(doc?.id === id ? {revision: doc.revision} : {}),
            })
            .catch(() => undefined);
        })();
      }, 300);
    },
    [doc, gitFile, gitOpen, selected, workspaceId],
  );

  const stateRef = useRef({doc, draft, selected});
  const focusEditorRef = useRef(false);
  stateRef.current = {doc, draft, selected};

  /** 当前这篇文档的 git 状态：用来决定「暂存 / 取消暂存」显示哪个。 */
  const docChange = doc ? changeByPath.get(doc.relPath) : undefined;

  /**
   * 主界面的 diff 以暂存区为基准：这篇有暂存内容时是「与暂存区对比」，
   * 没暂存过时基准就是 HEAD（暂存区与 HEAD 一致），所以直接说「与 HEAD 对比」。
   */
  const againstStaged = docChange !== undefined && isStaged(docChange);
  const diffCaption = againstStaged ? '与暂存区对比' : '与 HEAD 对比';
  const diffTitle = againstStaged ? '看与暂存区的对比' : '看与 HEAD 的对比';

  /** 路由里的 id 不在文档列表里：多半是失效链接。 */
  const missingDoc = Boolean(selected) && docs.length > 0 && !docs.some(item => item.id === selected);

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

  // 服务端推来的变化：文档改动重载对应的数据，dev 模式重构建完成则整页刷新。
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
      await applyExternal(change);
    };

    return () => socket.close();
  }, [applyExternal, loadDocs, loadGit, workspaceId]);

  const docDiff = useDocDiff(workspaceId, doc, draft, diffMode === 'file');


  /** 文档页的暂存：和审阅页共用 stage，再补一次文档自己的 diff。 */
  const stageDoc = async (path: string, unstage = false) => {
    await stage(path, unstage);
    await docDiff.reload();
  };

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

  /** 侧栏的新建入口：落盘后展开它所在的目录，聚焦编辑器。 */
  const createDoc = async (kind: DocKind) => {
    const folder = creatingFolder ?? kind;
    const id = await createDocInStore(folder, newId);

    if (!id) {
      return;
    }

    cancelCreate();
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

  const titleOf = useMemo(() => {
    const map = new Map(docs.map(item => [item.id, item.title]));
    return (id: string) => map.get(id) ?? id;
  }, [docs]);

  const diff = useMemo(() => {
    if (!doc || !diffMode) {
      return undefined;
    }

    if (diffMode === 'file') {
      if (!docDiff.sides) {
        return undefined;
      }

      const lines = diffLines(docDiff.sides.original, docDiff.sides.modified);
      return {
        original: docDiff.sides.original,
        modified: docDiff.sides.modified,
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
  }, [doc, draft, diffMode, incoming, docDiff.sides, diffCaption]);

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
                    <span className="switcher-count">{workspaces.length}</span>
                  </p>
                  <ul className="switcher-list">
                    {workspaces.map(item => (
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
                  {workspaces.length === 0 && (
                    <p className="switcher-empty">还没有记录过任何工作区</p>
                  )}
                  <form
                    className="switcher-add"
                    onSubmit={event => {
                      event.preventDefault();
                      void (async () => {
                        let added: {id: string};

                        try {
                          added = (
                            await api.addWorkspace(newWorkspace.trim(), newDocs.trim())
                          ).workspace;
                        } catch (error) {
                          setStatus(`添加失败：${messageOf(error)}`);
                          return;
                        }

                        setNewWorkspace('');
                        setNewDocs('');
                        setSwitcherOpen(false);
                        await loadWorkspaces();
                        navigate(`/w/${added.id}/`);
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
          <ReviewPane
            git={gitReview}
            onClose={() => (selected ? openDoc(selected) : navigate(`/w/${workspaceId}/`))}
            onPick={recordPick}
          />
        )}
        {!gitOpen && doc ? (
          <DocPane
            autoFocus={focusEditorRef.current}
            changeByPath={changeByPath}
            diff={diff}
            diffMode={diffMode}
            diffTitle={diffTitle}
            modelKey={docModelKey(workspaceId, doc.id)}
            onOpenChanges={() => navigate(`/w/${workspaceId}/changes`)}
            onOpenDiff={() => openDoc(doc.id, {diff: diffMode !== 'file'})}
            onPick={recordPick}
            onReload={() => void loadDoc(doc.id)}
            onStage={stageDoc}
            openLink={openLink}
            session={session}
            status={git}
            titleOf={titleOf}
          />
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
