import {useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction} from 'react';

import {api, ApiError, messageOf} from '../api.ts';
import type {Change, ConversationRecord, Doc, DocMeta, Incoming} from '../types.ts';

export interface DocSession {
  doc?: Doc;
  /** 编辑器当前内容（草稿优先）。 */
  draft: string;
  dirty: boolean;
  drafts: Record<string, string>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  /** 某篇有没有未保存的改动。 */
  hasDraft: (id: string) => boolean;
  incoming?: Incoming;
  showIncoming: boolean;
  setShowIncoming: Dispatch<SetStateAction<boolean>>;
  setIncoming: (value?: Incoming) => void;
  backlinks: DocMeta[];
  provenance: ConversationRecord[];
  showProvenance: boolean;
  setShowProvenance: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  loadDoc: (id: string) => Promise<Doc | undefined>;
  /** 磁盘上的文档被外部改了（`/ws` 推来的变化）。 */
  applyExternal: (change: Change) => Promise<void>;
  /** 放弃草稿，改用磁盘上的版本。 */
  acceptIncoming: () => void;
  save: () => Promise<void>;
  createDoc: (folder: string, id: string) => Promise<string | undefined>;
  removeDoc: () => Promise<void>;
}

/** 当前文档这一摊：正文、草稿、外部改动提示、保存与增删。 */
export function useDocSession(
  workspaceId: string,
  selected: string | undefined,
  options: {
    notify: (text: string, key?: string) => void;
    /** 保存成功后要顺带刷新别的东西（列表、git 状态）。 */
    onSaved?: () => void | Promise<void>;
    /** 文档删掉之后去哪儿。 */
    onRemoved?: () => void | Promise<void>;
  },
): DocSession {
  const {notify, onSaved, onRemoved} = options;
  const [doc, setDoc] = useState<Doc>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [incoming, setIncoming] = useState<Incoming>();
  const [showIncoming, setShowIncoming] = useState(false);
  const [backlinks, setBacklinks] = useState<DocMeta[]>([]);
  const [provenance, setProvenance] = useState<ConversationRecord[]>([]);
  const [showProvenance, setShowProvenance] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 自己刚写进去的内容，用来把回显和外部改动区分开。 */
  const pendingWrite = useRef<{id: string; body: string} | undefined>(undefined);
  const latest = useRef({doc, drafts, selected});
  latest.current = {doc, drafts, selected};

  const draft = selected ? drafts[selected] ?? doc?.body ?? '' : '';
  const dirty = doc !== undefined && draft !== doc.body;

  /**
   * 有没有未保存的改动。只有当前这篇能拿磁盘正文比对；已经切走的文档只剩草稿，
   * 有草稿就算有改动（编辑器只在用户真的敲字时才写草稿）。
   */
  const hasDraft = useCallback(
    (id: string) => {
      const current = latest.current;
      return drafts[id] !== undefined && (current.doc?.id === id ? drafts[id] !== current.doc.body : true);
    },
    [drafts],
  );

  const loadDoc = useCallback(
    async (id: string) => {
      let payload: Doc;

      try {
        payload = await api.doc(workspaceId, id);
      } catch (error) {
        notify(
          error instanceof ApiError && error.status === 404
            ? `${id} 不存在或已被删除`
            : `读取失败：${messageOf(error)}`,
        );
        return undefined;
      }

      setDoc(payload);
      setIncoming(undefined);
      setShowIncoming(false);
      setDrafts(current => {
        const next = {...current};
        delete next[id];
        return next;
      });
      return payload;
    },
    [notify, workspaceId],
  );

  const save = useCallback(async () => {
    const current = latest.current;

    if (!current.doc || current.drafts[current.doc.id] === undefined) {
      return;
    }

    const body = current.drafts[current.doc.id]!;

    if (body === current.doc.body) {
      return;
    }

    setBusy(true);
    notify('保存中…', 'save');
    pendingWrite.current = {id: current.doc.id, body};

    try {
      await api.writeDoc(workspaceId, current.doc.id, body, current.doc.revision);
    } catch (error) {
      pendingWrite.current = undefined;
      setBusy(false);
      notify(`保存失败：${messageOf(error)}`, 'save');
      await loadDoc(current.doc.id);
      return;
    }

    setBusy(false);
    notify('已保存', 'save');
    await loadDoc(current.doc.id);
    await onSaved?.();
  }, [loadDoc, notify, onSaved, workspaceId]);

  const createDoc = useCallback(
    async (folder: string, id: string) => {
      const typed = id.trim().replace(/\.md$/i, '');

      if (!typed) {
        notify('先填一个 id');
        return undefined;
      }

      // 输入按入口算相对路径：在 source 下写「ui/button」就是 source/ui/button；
      // 写成完整 id（source/… 或 derived/…）也可以，不会被再拼一层。
      const fullId = /^(source|derived)\//.test(typed) ? typed : `${folder}/${typed}`;
      setBusy(true);

      try {
        await api.createDoc(workspaceId, fullId, `# ${fullId.split('/').pop()}\n\n`);
      } catch (error) {
        setBusy(false);
        notify(
          error instanceof ApiError && error.status === 400 && /已存在/.test(messageOf(error))
            ? `已存在同名文档：${fullId}`
            : `创建失败：${messageOf(error)}`,
        );
        return undefined;
      }

      setBusy(false);
      await onSaved?.();
      return fullId;
    },
    [notify, onSaved, workspaceId],
  );

  const removeDoc = useCallback(async () => {
    const current = latest.current.doc;

    if (!current) {
      return;
    }

    setBusy(true);

    try {
      await api.removeDoc(workspaceId, current.id);
    } catch (error) {
      setBusy(false);
      notify(`删除失败：${messageOf(error)}`);
      return;
    }

    setBusy(false);
    notify(`${current.id} 已删除`);
    setDoc(undefined);
    await onRemoved?.();
  }, [notify, onRemoved, workspaceId]);

  // 切文档：清掉提示与「磁盘有新版本」，重新读一遍。
  useEffect(() => {
    if (!selected) {
      return;
    }

    notify('');
    setIncoming(undefined);
    setShowIncoming(false);
    void loadDoc(selected);
    setBacklinks([]);

    void (async () => {
      setBacklinks(await api.backlinks(workspaceId, selected).catch(() => []));
      setShowProvenance(false);
      setProvenance(await api.conversations(workspaceId, selected).catch(() => []));
    })();
  }, [loadDoc, notify, selected, workspaceId]);

  const applyExternal = useCallback(
    async (change: Change) => {
      const current = latest.current;

      if (change.id !== current.doc?.id || change.revision === current.doc?.revision) {
        return;
      }

      let fresh: Doc;

      try {
        fresh = await api.doc(workspaceId, change.id);
      } catch {
        if (change.type === 'deleted') {
          // 正在看的文档被删掉了：不要继续显示旧内容。
          setDoc(undefined);
          notify(`${change.id} 已被删除`);
        } else {
          notify('文档读取失败');
        }

        return;
      }

      const pending = pendingWrite.current;

      if (pending && pending.id === fresh.id && pending.body === fresh.body) {
        // 自己刚写的回声，不当作外部改动。
        pendingWrite.current = undefined;
        return;
      }

      const edited = current.drafts[fresh.id];

      if (edited === undefined || edited === current.doc?.body) {
        setDoc(fresh);
        setIncoming(undefined);
        notify('文档已被外部修改，已重新载入');
      } else {
        setIncoming({id: fresh.id, revision: fresh.revision, body: fresh.body});
        notify('磁盘上有新版本，你的草稿还没保存');
      }
    },
    [notify, workspaceId],
  );

  const acceptIncoming = useCallback(() => {
    const current = latest.current;

    if (!current.doc || !incoming) {
      return;
    }

    setDrafts(draftsNow => {
      const next = {...draftsNow};
      delete next[incoming.id];
      return next;
    });
    setDoc({...current.doc, body: incoming.body, revision: incoming.revision});
    setIncoming(undefined);
    setShowIncoming(false);
    notify('已载入磁盘版本，草稿丢弃');
  }, [incoming, notify]);

  return {
    doc,
    draft,
    dirty,
    drafts,
    setDrafts,
    hasDraft,
    incoming,
    showIncoming,
    setShowIncoming,
    setIncoming,
    backlinks,
    provenance,
    showProvenance,
    setShowProvenance,
    busy,
    loadDoc,
    applyExternal,
    acceptIncoming,
    save,
    createDoc,
    removeDoc,
  };
}
