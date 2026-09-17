import {Minus, Plus, X} from 'lucide-react';

import {parseGitDiff} from '../../core/diff.ts';
import {statusLabel} from '../format.ts';
import {hasUnstaged, isStaged} from '../types.ts';
import type {GitReview} from '../hooks/useGitReview.ts';
import {MarkdownDiff} from '../editors.tsx';

/** 审阅页：改动文件列表 + diff + 提交。 */
export function ReviewPane({git, onPick, onClose}: {git: GitReview; onPick: (pick: import('../editors.tsx').Pick | undefined) => void; onClose: () => void}) {
  return (
   <section className="git pane pane-review">
            <header>
              <div>
                <h2>审阅改动</h2>
                <p className="meta">
                  {git.status?.branch ? `分支 ${git.status.branch} · ` : ''}
                  {git.status ? `${git.status.changes.length} 个文件` : ''} · 只提交 source/ 与 derived/
                </p>
                {git.status && git.status.otherChanges > 0 && (
                  <p className="meta hint">
                    另有 {git.status?.otherChanges} 个非文档条目（代码等）未提交，不归这个工具管
                  </p>
                )}
              </div>
              <div className="actions">
                {git.status && git.status.changes.length > 0 && (
                  <button
                    className="stage-button"
                    onClick={() => void git.stage()}
                    title="把两层文档的改动全部暂存"
                    type="button"
                  >
                    全部暂存
                  </button>
                )}
                <button
                  onClick={() => (onClose())}
                  title="回到文档"
                  type="button"
                >
                  <X size={14} />
                  关闭
                </button>
              </div>
            </header>
            {!git.status?.available ? (
              <p className="meta git-fallback">{git.status?.reason ?? '拿不到 git 状态'}</p>
            ) : (
              <>
                <div className="git-body">
                  <ul className="git-files">
                    <li className="git-files-head">
                      <span className="git-files-count">{git.status?.changes.length} 个文件</span>
                      <div className="segmented" role="group" aria-label="diff 基准">
                        <button
                          className={git.base === 'head' ? 'on' : ''}
                          onClick={() => git.setBase('head')}
                          title="与已提交版本比较"
                          type="button"
                        >
                          HEAD
                        </button>
                        <button
                          className={git.base === 'index' ? 'on' : ''}
                          onClick={() => git.setBase('index')}
                          title="与暂存区比较"
                          type="button"
                        >
                          暂存区
                        </button>
                      </div>
                    </li>
                    {git.status?.changes.map(change => (
                      <li key={change.path}>
                        <div
                          className={`git-row layer-${change.path.startsWith('source/') ? 'source' : 'derived'}${
                            git.file === change.path ? ' active' : ''
                          }`}
                        >
                          <button
                            className="git-pick"
                            onClick={() => git.setFile(change.path)}
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
                              onClick={() => void git.stage(change.path)}
                              title="暂存这个文件"
                              type="button"
                            >
                              <Plus size={12} />
                            </button>
                          )}
                          {isStaged(change) && (
                            <button
                              className="git-stage"
                              onClick={() => void git.stage(change.path, true)}
                              title="取消暂存"
                              type="button"
                            >
                              <Minus size={12} />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                    {git.status?.changes.length === 0 && <li className="empty">没有未提交的文档改动</li>}
                  </ul>
                  <div className="git-diff">
                    {git.sides ? (
                      <MarkdownDiff
                        modified={git.sides.modified}
                        onPick={git.file ? onPick : undefined}
                        original={git.sides.original}
                      />
                    ) : (
                      <pre>
                        {parseGitDiff(git.diffText).map((line, index) => (
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
                    value={git.message}
                    onChange={event => git.setMessage(event.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={git.busy || git.commitCount === 0}
                    onClick={() => void git.commit()}
                    title={
                      git.stagedCount > 0
                        ? `只提交已暂存的 ${git.stagedCount} 篇`
                        : `把 ${git.commitCount} 篇文档的改动一起提交`
                    }
                    type="button"
                  >
                    提交 {git.commitCount} 个
                  </button>
                </div>
              </>
            )}
          </section>
        
  );
}
