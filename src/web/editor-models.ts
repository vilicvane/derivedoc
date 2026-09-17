import * as monaco from 'monaco-editor/editor/editor.api';

/**
 * 每篇文档一个 model：切换文档只是 `setModel`，编辑器不用重灌内容，撤销栈因此按文档各自
 * 留着——Monaco 的多文件编辑本来就是这么用的。
 *
 * 同一篇的正文真的被换掉时（磁盘上有新版本、用磁盘版本）走整段替换的 `pushEditOperations`：
 * 它落在撤销栈上，⌘Z 能把换掉之前的内容找回来。不能用 `setValue`，它内部会 clear
 * command manager，整条撤销栈一起没；也不该用 `applyEdits`，那是绕过撤销栈的静默编辑，
 * 旧的历史条目会指向新正文，撤销时改坏内容。
 */

const models = new Map<string, monaco.editor.ITextModel>();
/** 正挂在编辑器上的 model：清理时要绕开它们。 */
const attached = new Set<string>();

export function docModelKey(workspaceId: string, docId: string): string {
  return `${workspaceId}/${docId}`;
}

/** 取这篇的 model，没有就按给定内容建一个。 */
export function acquireModel(key: string, value: string): monaco.editor.ITextModel {
  let model = models.get(key);

  if (!model) {
    model = monaco.editor.createModel(value, 'markdown');
    models.set(key, model);
  }

  return model;
}

export function attachModel(key: string): void {
  attached.add(key);
}

export function detachModel(key: string): void {
  attached.delete(key);
}

/** 正文和编辑器里显示的不一致时整段替换。替换本身可撤销，撤销后就是替换前的内容。 */
export function syncModel(model: monaco.editor.ITextModel, value: string): void {
  if (model.getValue() === value) {
    return;
  }

  // 替换自成一步撤销：⌘Z 只回退这次替换，不会把用户之前的输入一起撤掉。
  model.pushStackElement();
  model.pushEditOperations(null, [{range: model.getFullModelRange(), text: value}], () => null);
  model.pushStackElement();
}

/** 文档列表变了：把已经不在列表里的 model 清掉，别一直攒着。 */
export function pruneModels(keys: Iterable<string>): void {
  const keep = new Set(keys);

  for (const [key, model] of models) {
    if (keep.has(key) || attached.has(key)) {
      continue;
    }

    model.dispose();
    models.delete(key);
  }
}
