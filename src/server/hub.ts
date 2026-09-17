import path from 'node:path';

import type {DocChange} from '../core/types.ts';
import {initProject, findProjectRoot} from '../core/project.ts';
import {listWorkspaces, registerWorkspace, workspaceId, type WorkspaceRef} from '../core/registry.ts';
import {DocStore} from '../core/store.ts';

export interface WorkspaceChange extends DocChange {
  ws: string;
}

/** 一个进程托管多个工作区：按 id 懒加载各自的 DocStore。 */
export class WorkspaceHub {
  readonly defaultId: string;

  #stores = new Map<string, DocStore>();
  #refs = new Map<string, WorkspaceRef>();
  #listeners = new Set<(change: WorkspaceChange) => void>();
  #unsubscribes = new Map<string, () => void>();

  private constructor(root: string) {
    this.defaultId = workspaceId(root);
  }

  static async open(root: string): Promise<WorkspaceHub> {
    const hub = new WorkspaceHub(path.resolve(root));
    await hub.openRoot(path.resolve(root));
    return hub;
  }

  /** 工作区列表：注册表里的全部条目，标注哪些已经打开。 */
  async list(): Promise<Array<WorkspaceRef & {open: boolean}>> {
    const registered = await listWorkspaces();
    const seen = new Map(registered.map(entry => [entry.id, entry]));

    for (const ref of this.#refs.values()) {
      seen.set(ref.id, ref);
    }

    return [...seen.values()]
      .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
      .map(ref => ({...ref, open: this.#stores.has(ref.id)}));
  }

  /** 取某个工作区的 store；没打开过就按注册表路径打开。 */
  async get(id: string): Promise<DocStore | undefined> {
    const existing = this.#stores.get(id);

    if (existing) {
      return existing;
    }

    const known = (await listWorkspaces()).find(entry => entry.id === id);

    if (!known) {
      return undefined;
    }

    await this.openRoot(known.root);
    return this.#stores.get(id);
  }

  /** 显式添加一个工作区（界面上填路径时用）。 */
  async add(root: string): Promise<WorkspaceRef> {
    const resolved = await findProjectRoot(path.resolve(root));

    if (!resolved) {
      throw new Error(`${root} 不是 derivedoc 工作区（找不到 .derivedoc 目录）`);
    }

    await initProject(resolved);
    return this.openRoot(resolved);
  }

  onChange(listener: (change: WorkspaceChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.#unsubscribes.values()) {
      unsubscribe();
    }

    for (const store of this.#stores.values()) {
      await store.close();
    }

    this.#stores.clear();
    this.#refs.clear();
    this.#listeners.clear();
  }

  private async openRoot(root: string): Promise<WorkspaceRef> {
    const ref = await registerWorkspace(root);
    const existing = this.#stores.get(ref.id);

    if (existing) {
      this.#refs.set(ref.id, ref);
      return ref;
    }

    const store = await DocStore.open(root);
    const unsubscribe = store.onChange(change => {
      for (const listener of this.#listeners) {
        listener({...change, ws: ref.id});
      }
    });

    this.#stores.set(ref.id, store);
    this.#refs.set(ref.id, ref);
    this.#unsubscribes.set(ref.id, unsubscribe);

    return ref;
  }
}
