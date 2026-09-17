import {useCallback, useEffect, useMemo, useState} from 'react';

import {api, messageOf} from '../api.ts';
import {draftMessage} from '../format.ts';
import type {GitChange, GitStatus} from '../types.ts';

export interface GitReview {
  status?: GitStatus;
  /** 审阅页当前选中的文件。 */
  file?: string;
  setFile: (file?: string) => void;
  /** 审阅页的 diff 基准。 */
  base: 'head' | 'index';
  setBase: (base: 'head' | 'index') => void;
  diffText: string;
  sides?: {original: string; modified: string};
  message: string;
  setMessage: (message: string) => void;
  busy: boolean;
  changeByPath: Map<string, GitChange>;
  /** 这次提交会带上几篇：暂存过按暂存的算，否则算全部文档改动。 */
  commitCount: number;
  stagedCount: number;
  loadGit: (options?: {keepMessage?: boolean}) => Promise<GitStatus | undefined>;
  loadDiff: (file?: string, base?: 'head' | 'index') => Promise<void>;
  stage: (file?: string, unstage?: boolean) => Promise<void>;
  commit: () => Promise<void>;
}

/**
 * 审阅相关的状态：git 状态、文件列表选中项、diff（含基准切换）、暂存与提交。
 *
 * @param review 是否停在审阅页：进入时才去拉那个文件的 diff。
 */
export function useGitReview(
  workspaceId: string,
  options: {
    review: boolean;
    notify: (text: string, key?: string) => void;
    /** 提交之后调用方要做的收尾（重载文档、回到文档页等）。 */
    onCommitted: () => void | Promise<void>;
  },
): GitReview {
  const {review, notify, onCommitted} = options;
  const [status, setStatus] = useState<GitStatus>();
  const [file, setFile] = useState<string>();
  const [diffText, setDiffText] = useState('');
  const [sides, setSides] = useState<{original: string; modified: string}>();
  const [base, setBase] = useState<'head' | 'index'>('head');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadGit = useCallback(
    async (loadOptions: {keepMessage?: boolean} = {}) => {
      const payload = await api.gitStatus(workspaceId).catch(() => undefined);

      if (!payload) {
        setStatus(undefined);
        return undefined;
      }

      setStatus(payload);

      if (!loadOptions.keepMessage) {
        setMessage(payload.message?.trim() || draftMessage(payload.changes));
      }

      return payload;
    },
    [workspaceId],
  );

  const loadDiff = useCallback(
    async (nextFile?: string, nextBase: 'head' | 'index' = 'head') => {
      let text: string;

      try {
        text = await api.gitDiff(workspaceId, nextFile, nextBase);
      } catch {
        setDiffText('');
        setSides(undefined);
        return;
      }

      setDiffText(text);

      if (!nextFile) {
        setSides(undefined);
        return;
      }

      setSides(await api.gitShow(workspaceId, nextFile, nextBase).catch(() => undefined));
    },
    [workspaceId],
  );

  // 审阅页总是盯着一篇：没选、或选中的文件已经不在改动里，就落到第一篇。
  useEffect(() => {
    if (!review) {
      return;
    }

    const list = status?.changes ?? [];

    if (list.length === 0) {
      setFile(undefined);
      return;
    }

    setFile(current =>
      current && list.some(change => change.path === current) ? current : list[0]!.path,
    );
  }, [review, status]);

  useEffect(() => {
    if (review) {
      void loadDiff(file, base);
    }
  }, [review, file, base, loadDiff]);

  const stage = useCallback(
    async (path?: string, unstage = false) => {
      setBusy(true);

      try {
        setStatus(await api.stage(workspaceId, path, unstage));
      } catch {
        setBusy(false);
        notify(unstage ? '取消暂存失败' : '暂存失败');
        return;
      }

      setBusy(false);
      await loadDiff(path ?? file, base);
    },
    [base, file, loadDiff, notify, workspaceId],
  );

  const commit = useCallback(async () => {
    setBusy(true);

    let payload: {ok: boolean; sha?: string; error?: string};

    try {
      payload = await api.commit(workspaceId, message);
    } catch (error) {
      setBusy(false);
      notify(`提交失败：${messageOf(error)}`);
      return;
    }

    setBusy(false);

    if (!payload.ok) {
      notify(`提交失败：${payload.error ?? '未知原因'}`);
      return;
    }

    notify(`已提交 ${payload.sha}`);
    setMessage('');
    setFile(undefined);
    await loadGit();
    await loadDiff(undefined);
    await onCommitted();
  }, [loadDiff, loadGit, message, notify, onCommitted, workspaceId]);

  const changeByPath = useMemo(
    () => new Map((status?.changes ?? []).map(change => [change.path, change])),
    [status],
  );

  const stagedCount = (status?.changes ?? []).filter(
    change => change.index !== ' ' && change.index !== '?',
  ).length;
  const commitCount = stagedCount > 0 ? stagedCount : (status?.changes.length ?? 0);

  return {
    status,
    file,
    setFile,
    base,
    setBase,
    diffText,
    sides,
    message,
    setMessage,
    busy,
    changeByPath,
    commitCount,
    stagedCount,
    loadGit,
    loadDiff,
    stage,
    commit,
  };
}
