import type {DocChange} from '../core/types.ts';
import {initProject, locateWorkspace, type WorkspacePaths} from '../core/project.ts';
import {listWorkspaces, registerWorkspace, workspaceId, type WorkspaceRef} from '../core/registry.ts';
import {DocStore} from '../core/store.ts';

export interface WorkspaceChange extends DocChange {
  ws: string;
}

/** 一个已打开的工作区：文档来自文档目录，其余运行数据归项目根。 */
export interface WorkspaceView {
  ref: WorkspaceRef;
  store: DocStore;
}

/** 一个进程托管多个工作区：按 id 懒加载各自的 DocStore。 */
export class WorkspaceHub {
  readonly defaultId: string;

  #views = new Map<string, WorkspaceView>();
  #listeners = new Set<(change: WorkspaceChange) => void>();
  #unsubscribes = new Map<string, () => void>();

  private constructor(paths: WorkspacePaths) {
    this.defaultId = workspaceId(paths.root);
  }

  static async open(paths: WorkspacePaths): Promise<WorkspaceHub> {
    const hub = new WorkspaceHub(paths);
    await hub.openRoot(paths);
    return hub;
  }

  /** 工作区列表：注册表里的全部条目，标注哪些已经打开。 */
  async list(): Promise<Array<WorkspaceRef & {open: boolean}>> {
    const registered = await listWorkspaces();
    const seen = new Map(registered.map(entry => [entry.id, entry]));

    for (const view of this.#views.values()) {
      seen.set(view.ref.id, view.ref);
    }

    return [...seen.values()]
      .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
      .map(ref => ({...ref, open: this.#views.has(ref.id)}));
  }

  /** 取某个工作区；没打开过就按注册表里的路径打开。 */
  async get(id: string): Promise<WorkspaceView | undefined> {
    const existing = this.#views.get(id);

    if (existing) {
      return existing;
    }

    const known = (await listWorkspaces()).find(entry => entry.id === id);

    if (!known) {
      return undefined;
    }

    // 以项目里记下的文档目录为准：--doc-dir 改过之后，注册表可能还是旧的。
    const paths = await locateWorkspace(known.root, {cwd: known.root});

    if (!paths) {
      return undefined;
    }

    await this.openRoot(paths);
    return this.#views.get(id);
  }

  /** 显式添加一个工作区（界面上填路径时用）：路径可以是项目根，也可以是文档目录。 */
  async add(input: string): Promise<WorkspaceRef> {
    const resolved = await locateWorkspace(input, {cwd: process.cwd()});

    if (!resolved) {
      throw new Error(
        `${input} 里找不到 .derivedoc 目录：先在项目根跑 dd <文档目录> 建工作区`,
      );
    }

    await initProject(resolved.root, resolved.docs);
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

    for (const view of this.#views.values()) {
      await view.store.close();
    }

    this.#views.clear();
    this.#listeners.clear();
  }

  private async openRoot(paths: WorkspacePaths): Promise<WorkspaceRef> {
    const ref = await registerWorkspace(paths);
    const existing = this.#views.get(ref.id);

    if (existing) {
      this.#views.set(ref.id, {ref, store: existing.store});
      return ref;
    }

    const store = await DocStore.open(paths.docs);
    const unsubscribe = store.onChange(change => {
      for (const listener of this.#listeners) {
        listener({...change, ws: ref.id});
      }
    });

    this.#views.set(ref.id, {ref, store});
    this.#unsubscribes.set(ref.id, unsubscribe);

    return ref;
  }
}
