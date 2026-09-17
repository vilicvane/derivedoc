import {
  Check,
  Columns2,
  GitCommitHorizontal,
  Minus,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import {useState} from 'react';

import {formatTime} from '../format.ts';
import {hasUnstaged, isStaged, type GitChange, type GitStatus} from '../types.ts';
import type {DocSession} from '../hooks/useDocSession.ts';
import {MarkdownDiff, MarkdownEditor, type Pick} from '../editors.tsx';

/** 一篇文档：标题与动作、两条横幅、引用关系、来源，以及编辑器或 diff。 */
export function DocPane({
  session,
  status,
  changeByPath,
  diff,
  diffMode,
  diffTitle,
  autoFocus,
  onOpenDiff,
  onOpenChanges,
  onReload,
  onStage,
  onPick,
  openLink,
  titleOf,
}: {
  session: DocSession;
  status?: GitStatus;
  changeByPath: Map<string, GitChange>;
  diff?: {
    original: string;
    modified: string;
    summary: {added: number; removed: number};
    caption: string;
  };
  diffMode?: 'file' | 'incoming';
  diffTitle: string;
  autoFocus: boolean;
  onOpenDiff: () => void;
  onOpenChanges: () => void;
  onReload: () => void;
  onStage: (path: string, unstage?: boolean) => Promise<void>;
  onPick: (pick: Pick | undefined) => void;
  openLink: (id: string) => void;
  titleOf: (id: string) => string;
}) {
  const {
    doc,
    draft,
    dirty,
    busy,
    setDraft,
    incoming,
    showIncoming,
    setShowIncoming,
    acceptIncoming,
    backlinks,
    provenance,
    showProvenance,
    setShowProvenance,
    save,
    removeDoc,
  } = session;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (!doc) {
    return null;
  }

  const change = changeByPath.get(doc.relPath);
  const changeDraft = (value: string) => setDraft(doc.id, value);

  return (
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
          {status?.available && (
            <button onClick={onOpenChanges} title="待提交的文档改动" type="button">
              <GitCommitHorizontal size={14} />
              {`变更 ${status.changes.length}`}
            </button>
          )}
          {(dirty || changeByPath.has(doc.relPath)) && (
            <button
              onClick={onOpenDiff}
              title={diffMode === 'file' ? '回到编辑' : diffTitle}
              type="button"
            >
              <Columns2 size={14} />
              {diffMode === 'file' ? '编辑' : '对比'}
            </button>
          )}
          <button onClick={onReload} title="丢弃草稿并重新读取" type="button">
            <RotateCw size={14} />
            重新载入
          </button>
          {change && hasUnstaged(change) && (
            <button
              className="stage-button"
              disabled={busy}
              onClick={() => void onStage(doc.relPath)}
              title="把这篇的改动放进暂存区，之后在审阅页提交"
              type="button"
            >
              <Plus size={14} />
              暂存
            </button>
          )}
          {change && isStaged(change) && (
            <button
              disabled={busy}
              onClick={() => void onStage(doc.relPath, true)}
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
          <button onClick={() => setShowIncoming(value => !value)} type="button">
            {showIncoming ? '回到草稿' : '看差异'}
          </button>
          <button onClick={acceptIncoming} type="button">
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
          {provenance.map(record => (
            <li key={`${record.sessionId}-${record.at}`}>
              <div className="provenance-head">
                <span className="when">{formatTime(record.at)}</span>
                <span className="channel">{record.channel}</span>
                <span className="turn">
                  {record.turnId?.slice(0, 8) ?? record.sessionId.slice(0, 8)}
                </span>
              </div>
              <p className="said">{record.text}</p>
              <p className="meta">
                {record.captures.some(capture => capture.thinking)
                  ? `思考：${record.captures.find(capture => capture.thinking)?.thinking}`
                  : '没有留下思考产物'}
              </p>
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
            <button onClick={onOpenDiff} type="button">
              关闭
            </button>
          </div>
          <MarkdownDiff
            modified={diff.modified}
            onChange={changeDraft}
            onPick={onPick}
            original={diff.original}
          />
        </section>
      ) : (
          <MarkdownEditor
            autoFocus={autoFocus}
            onChange={changeDraft}
            onPick={onPick}
            value={draft}
          />
      )}
    </div>
  );
}
