import {useCallback, useEffect, useState} from 'react';

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
  const [sides, setSides] = useState<{original: string; modified: string}>();

  const reload = useCallback(async () => {
    if (!doc) {
      return;
    }

    const payload = await api.gitShow(workspaceId, doc.relPath, 'index').catch(() => undefined);

    setSides(payload ? {original: payload.original, modified: draft} : undefined);
  }, [doc, draft, workspaceId]);

  useEffect(() => {
    if (enabled) {
      void reload();
    } else {
      setSides(undefined);
    }
  }, [enabled, reload]);

  return {sides, reload};
}
