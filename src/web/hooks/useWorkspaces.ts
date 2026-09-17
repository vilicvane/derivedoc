import {useCallback, useEffect, useState} from 'react';

import {api} from '../api.ts';
import type {WorkspaceInfo, WorkspaceRef} from '../types.ts';

/** 当前工作区的基本信息 + 注册表里的工作区列表。 */
export function useWorkspaces(workspaceId: string): {
  workspace?: WorkspaceInfo;
  workspaces: WorkspaceRef[];
  loadWorkspaces: () => Promise<void>;
} {
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);

  const loadWorkspaces = useCallback(async () => {
    const payload = await api.workspaces().catch(() => undefined);

    if (payload) {
      setWorkspaces(payload.workspaces);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const payload = await api.workspace(workspaceId).catch(() => undefined);

      if (!payload) {
        return;
      }

      const name = payload.root.split('/').filter(Boolean).pop() ?? payload.root;
      setWorkspace({root: payload.root, docs: payload.docs, name});
      document.title = `${name} · derivedoc`;
    })();
    void loadWorkspaces();
  }, [workspaceId, loadWorkspaces]);

  return {workspace, workspaces, loadWorkspaces};
}
