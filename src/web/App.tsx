import MarkdownIt from 'markdown-it';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

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

interface SearchHit extends DocMeta {
  snippet: string;
}

interface GitChange {
  path: string;
  index: string;
  worktree: string;
}

interface GitStatus {
  available: boolean;
  reason?: string;
  branch?: string;
  changes: GitChange[];
  message?: string;
}

export function App() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [selected, setSelected] = useState<string>();
  const [doc, setDoc] = useState<Doc>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [incoming, setIncoming] = useState<Incoming>();
  const [backlinks, setBacklinks] = useState<DocMeta[]>([]);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState<DocKind>();
  const [newId, setNewId] = useState('');
  const [diffMode, setDiffMode] = useState<'mine' | 'incoming'>();
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>();
  const [git, setGit] = useState<GitStatus>();
  const [gitOpen, setGitOpen] = useState(false);
  const [gitFile, setGitFile] = useState<string>();
  const [gitDiffText, setGitDiffText] = useState('');
  const [gitSides, setGitSides] = useState<{original: string; modified: string}>();
  const [gitMessage, setGitMessage] = useState('');
  const [gitBusy, setGitBusy] = useState(false);

  const draft = selected ? drafts[selected] ?? doc?.body ?? '' : '';
  const dirty = doc !== undefined && draft !== doc.body;

  const stateRef = useRef({doc, draft, selected});
  const pendingWriteRef = useRef<{id: string; body: string} | undefined>(undefined);
  stateRef.current = {doc, draft, selected};

  const loadDocs = useCallback(async () => {
    const response = await fetch('/api/docs');
    const payload = (await response.json()) as {docs: DocMeta[]};
    setDocs(payload.docs);
    return payload.docs;
  }, []);

  const loadDoc = useCallback(async (id: string) => {
    const response = await fetch(`/api/doc?id=${encodeURIComponent(id)}`);

    if (!response.ok) {
      setStatus(`读取失败：${response.status}`);
      return undefined;
    }

    const payload = (await response.json()) as Doc;
    setDoc(payload);
    setIncoming(undefined);
    setDiffMode(undefined);
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
      const first = list.find(item => item.kind === 'source') ?? list[0];

      if (first) {
        setSelected(first.id);
      }
    });
    void loadGit();
  }, [loadDocs, loadGit]);

  useEffect(() => {
    if (!selected) {
      return;
    }

    setStatus('');
    void loadDoc(selected);
    void loadBacklinks(selected);
  }, [selected, loadDoc, loadBacklinks]);

  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);

    socket.onmessage = async event => {
      const change = JSON.parse(event.data as string) as Change | {type: 'ready'};

      if (change.type === 'ready') {
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
        setStatus('文档被删除或读取失败');
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
        setDiffMode(undefined);
        setEditing(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  const createDoc = async (kind: DocKind) => {
    const id = newId.trim().replace(/\.md$/i, '');
    const fullId = id.includes('/') ? id : `${kind}/${id}`;

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
      setStatus(`创建失败：${payload.error?.message ?? response.status}`);
      return;
    }

    setCreating(undefined);
    setNewId('');
    await loadDocs();
    setSelected(fullId);
    setEditing(true);
  };

  const removeDoc = async () => {
    if (!doc) {
      return;
    }

    if (!window.confirm(`删除 ${doc.id}？这个操作直接从磁盘删文件。`)) {
      return;
    }

    setBusy(true);
    const response = await fetch(`/api/doc?id=${encodeURIComponent(doc.id)}`, {method: 'DELETE'});
    setBusy(false);

    if (!response.ok) {
      setStatus(`删除失败：${response.status}`);
      return;
    }

    setStatus(`${doc.id} 已删除`);
    setDoc(undefined);
    setSelected(undefined);
    const list = await loadDocs();
    const next = list.find(item => item.kind === 'source') ?? list[0];

    if (next) {
      setSelected(next.id);
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

  const rendered = useMemo(() => (doc ? markdown.render(doc.body) : ''), [doc]);

  const diff = useMemo(() => {
    if (!doc || !diffMode) {
      return undefined;
    }

    if (diffMode === 'mine') {
      const lines = diffLines(doc.body, draft);
      return {
        original: doc.body,
        modified: draft,
        summary: summarizeDiff(lines),
        caption: '你的改动（草稿与磁盘现状的差异）',
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
  }, [doc, draft, diffMode, incoming]);

  const openLink = (id: string) => {
    if (docs.some(item => item.id === id)) {
      setSelected(id);
      setEditing(false);
      return;
    }

    setStatus(`链接目标不在项目里：${id}`);
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
        {hits ? (
          <section>
            <h2>
              <span>搜索结果</span>
              <span className="count">{hits.length}</span>
            </h2>
            <ul className="hits">
              {hits.map(hit => (
                <li key={hit.id}>
                  <button
                    className={hit.id === selected ? 'active' : ''}
                    onClick={() => {
                      setSelected(hit.id);
                      setEditing(false);
                    }}
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
          (['source', 'derived'] as const).map(kind => (
          <section key={kind}>
            <h2>
              <span>{kind === 'source' ? 'source · 决定' : 'derived · 方案'}</span>
              <span className="count">{visible(kind).length}</span>
              <button
                className="ghost"
                title={`新建 ${kind} 文档`}
                onClick={() => {
                  setCreating(kind);
                  setNewId('');
                }}
                type="button"
              >
                ＋
              </button>
            </h2>
            {creating === kind && (
              <form
                className="create"
                onSubmit={event => {
                  event.preventDefault();
                  void createDoc(kind);
                }}
              >
                <input
                  autoFocus
                  placeholder={`${kind}/新文档`}
                  value={newId}
                  onChange={event => setNewId(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      setCreating(undefined);
                    }
                  }}
                />
                <button disabled={busy} type="submit">
                  建
                </button>
              </form>
            )}
            <ul>
              {visible(kind).map(item => (
                <li key={item.id}>
                  <button
                    className={item.id === selected ? 'active' : ''}
                    onClick={() => {
                      setSelected(item.id);
                      setEditing(false);
                    }}
                    type="button"
                  >
                    <span>{item.title}</span>
                    {drafts[item.id] !== undefined && <span className="dot" title="有未保存的草稿" />}
                  </button>
                </li>
              ))}
              {visible(kind).length === 0 && <li className="empty">没有匹配的文档</li>}
            </ul>
          </section>
          ))
        )}
      </aside>
      <main className="main">
        {gitOpen && (
          <section className="git">
            <header>
              <div>
                <h2>待提交的文档改动</h2>
                <p className="meta">
                  {git?.branch ? `分支 ${git.branch} · ` : ''}
                  范围 source/ 与 derived/
                </p>
              </div>
              <div className="actions">
                <button onClick={() => setGitOpen(false)} type="button">
                  回到文档
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
        {doc ? (
          <>
            <header>
              <div>
                <h2>{doc.title}</h2>
                <p className="meta">
                  {doc.id} · {doc.revision}
                  {dirty && <span className="dirty">未保存</span>}
                </p>
              </div>
              <div className="actions">
                {git?.available && (
                  <button onClick={() => setGitOpen(value => !value)} type="button">
                    {gitOpen ? '回到文档' : `变更 ${git.changes.length}`}
                  </button>
                )}
                {dirty && (
                  <button onClick={() => setDiffMode(mode => (mode === 'mine' ? undefined : 'mine'))} type="button">
                    改动
                  </button>
                )}
                <button onClick={() => setEditing(value => !value)} type="button">
                  {editing ? '阅读' : '编辑'}
                </button>
                <button onClick={() => void loadDoc(doc.id)} type="button">
                  重新载入
                </button>
                <button className="danger" onClick={() => void removeDoc()} type="button">
                  删除
                </button>
                <button
                  className="primary"
                  disabled={!dirty || busy}
                  onClick={() => void save()}
                  type="button"
                >
                  保存
                </button>
              </div>
            </header>

            {incoming && (
              <div className="banner">
                <span>磁盘上出现了新版本。</span>
                <button
                  onClick={() => setDiffMode(mode => (mode === 'incoming' ? undefined : 'incoming'))}
                  type="button"
                >
                  看差异
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
                    setDiffMode(undefined);
                    setStatus('已载入磁盘版本，草稿丢弃');
                  }}
                  type="button"
                >
                  用磁盘版本
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
                  <span className="count">{formatSummary(diff.summary)}</span>
                  <button onClick={() => setDiffMode(undefined)} type="button">
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
            ) : editing ? (
              <MarkdownEditor
                onChange={value => setDrafts(current => ({...current, [doc.id]: value}))}
                value={draft}
              />
            ) : (
              <div
                className="markdown"
                dangerouslySetInnerHTML={{__html: rendered}}
                onClick={onContentClick}
              />
            )}
          </>
        ) : (
          <p className="meta">左侧选择一篇文档，或者新建一篇。</p>
        )}
        {status && <p className="status">{status}</p>}
      </main>
    </div>
  );
}
