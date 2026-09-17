import {useCallback, useEffect, useMemo, useState} from 'react';

import {api} from '../api.ts';
import {buildTree, flattenTree, type TreeNode} from '../tree.ts';
import type {DocMeta, SearchHit} from '../types.ts';

/** 文档列表、由它推出的目录树，以及标题/正文的搜索结果。 */
export function useDocs(
  workspaceId: string,
  filter: string,
): {
  docs: DocMeta[];
  tree: TreeNode[];
  flatDocs: DocMeta[];
  hits?: SearchHit[];
  loadDocs: () => Promise<DocMeta[]>;
} {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [hits, setHits] = useState<SearchHit[]>();

  const loadDocs = useCallback(async () => {
    const list = await api.docs(workspaceId);
    setDocs(list);
    return list;
  }, [workspaceId]);

  const tree = useMemo(() => buildTree(docs), [docs]);
  const flatDocs = useMemo(() => flattenTree(tree), [tree]);

  // 过滤框就是搜索框：停手 150ms 再打接口。
  useEffect(() => {
    const query = filter.trim();

    if (!query) {
      setHits(undefined);
      return;
    }

    const timer = setTimeout(async () => {
      const found = await api.search(workspaceId, query).catch(() => undefined);

      if (found) {
        setHits(found);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [filter, workspaceId]);

  return {docs, tree, flatDocs, hits, loadDocs};
}
