import {useCallback, useEffect, useMemo, useState} from 'react';

import {api} from '../api.ts';

/** 文档页的 diff：以暂存区为基准，对比当前编辑器内容。 */
export function useDocDiff(
  workspaceId: string,
  doc: {relPath: string} | undefined,
  draft: string,
  enabled: boolean,
): {
  sides?: {original: string; modified: string};
  reload: () => Promise<void>;
} {
  /** 基准（暂存区或 HEAD）那一侧的正文，右边永远跟着草稿走。 */
  const [original, setOriginal] = useState<string>();
  const relPath = doc?.relPath;

  const reload = useCallback(async () => {
    if (!relPath) {
      return;
    }

    const payload = await api.gitShow(workspaceId, relPath, 'index').catch(() => undefined);

    setOriginal(payload?.original);
  }, [relPath, workspaceId]);

  useEffect(() => {
    if (enabled) {
      void reload();
    } else {
      setOriginal(undefined);
    }
  }, [enabled, reload]);

  // 右边跟着草稿走，不再为了每次按键重跑一次请求。
  const sides = useMemo(
    () => (original === undefined ? undefined : {original, modified: draft}),
    [original, draft],
  );

  return {sides, reload};
}
