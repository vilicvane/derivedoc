import {useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction} from 'react';

import {api, ApiError, messageOf} from '../api.ts';
import type {Change, ConversationRecord, Doc, DocMeta, Incoming} from '../types.ts';

/**
 * 一篇的草稿：内容，加上它基于的磁盘版本。正文用来判断离开期间磁盘动没动，
 * 修订号用来保存——草稿改了哪一版，就按哪一版提交，免得盖掉别人的改动。
 */
interface Draft {
  value: string;
  base: string;
  revision: string;
}

export interface DocSession {
  doc?: Doc;
  /** 编辑器当前内容（草稿优先）。 */
  draft: string;
  dirty: boolean;
  /** 记下某篇的草稿；内容与磁盘一致就当作没改过，不留下草稿。 */
  setDraft: (id: string, value: string) => void;
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
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
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

  const stored = selected ? drafts[selected] : undefined;
  const draft = stored?.value ?? doc?.body ?? '';
  const dirty = doc !== undefined && draft !== doc.body;

  /**
   * 有没有未保存的改动。当前这篇拿磁盘正文比对；已经切走的文档留着草稿，
   * 有草稿就是有改动（草稿只会在内容真的和磁盘不同时才存在）。
   */
  const hasDraft = useCallback(
    (id: string) => {
      const current = latest.current;
      const entry = drafts[id];

      return entry !== undefined && (current.doc?.id === id ? entry.value !== current.doc.body : true);
    },
    [drafts],
  );

  /**
   * 记草稿。编辑器只在用户真的敲字时回报内容，但敲回来的内容可能又和磁盘一样
   * （比如撤销到底）——那就当没改过，把草稿删掉。留在那里的话，一旦切到别的
   * 文档就没法再和磁盘比对，标记会一直亮着，看起来像凭空冒出来的未保存。
   *
   * 每个草稿记下它基于的磁盘正文：切走再回来时，靠它知道磁盘在这期间动没动。
   */
  const setDraft = useCallback(
    (id: string, value: string) => {
      const current = latest.current;
      const doc = current.doc?.id === id ? current.doc : undefined;

      setDrafts(current => {
        const entry = current[id];

        if (value === doc?.body) {
          if (entry === undefined) {
            return current;
          }

          const next = {...current};
          delete next[id];
          return next;
        }

        // 已经开过头就沿用原来的基准：中间来过的外部改动不该被算进这份草稿的底子。
        const basis = entry ?? {base: doc?.body ?? '', revision: doc?.revision ?? ''};

        return entry?.value === value ? current : {...current, [id]: {...basis, value}};
      });
    },
    [],
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
      setShowIncoming(false);

      const entry = latest.current.drafts[id];

      if (entry === undefined || entry.value === payload.body) {
        // 没改过，或者改回了磁盘上的样子：把草稿清掉，别留下假的未保存。
        setIncoming(undefined);
        setDrafts(current => {
          if (current[id] === undefined) {
            return current;
          }

          const next = {...current};
          delete next[id];
          return next;
        });
      } else if (entry.base === payload.body) {
        // 离开的这段时间磁盘没动，草稿接着用，不打扰。
        setIncoming(undefined);
      } else {
        // 离开的这段时间磁盘动过：草稿留着，横幅说明有分歧（这里不再多弹一条提示）。
        setIncoming({id, revision: payload.revision, body: payload.body});
      }

      return payload;
    },
    [notify, workspaceId],
  );

  const save = useCallback(async () => {
    const current = latest.current;

    const entry = current.doc ? current.drafts[current.doc.id] : undefined;

    if (!current.doc || entry === undefined) {
      return;
    }

    const body = entry.value;

    if (body === current.doc.body) {
      return;
    }

    setBusy(true);
    notify('保存中…', 'save');
    pendingWrite.current = {id: current.doc.id, body};

    try {
      await api.writeDoc(workspaceId, current.doc.id, body, entry.revision);
    } catch (error) {
      pendingWrite.current = undefined;
      setBusy(false);
      notify(
        error instanceof ApiError && error.status === 409
          ? '磁盘上有新版本，草稿先留着：看差异决定怎么合'
          : `保存失败：${messageOf(error)}`,
        'save',
      );
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

      const edited = current.drafts[fresh.id]?.value;

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
    setDraft,
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
