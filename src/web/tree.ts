import type {DocKind, DocMeta} from './types.ts';

/** 侧栏目录树的节点：没有 `doc` 的就是文件夹。 */
export interface TreeNode {
  name: string;
  path: string;
  kind: DocKind;
  depth: number;
  children: TreeNode[];
  doc?: DocMeta;
}

/** 由文档列表搭出 source / derived 两棵树。 */
export function buildTree(docs: DocMeta[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();

  // 两个根始终存在：空项目也要有新建入口，并让层级结构可见。
  for (const kind of ['source', 'derived'] as const) {
    const root: TreeNode = {name: kind, path: kind, kind, depth: 0, children: []};
    nodes.set(kind, root);
    roots.push(root);
  }

  for (const doc of [...docs].sort((a, b) => a.id.localeCompare(b.id))) {
    const segments = doc.id.split('/');
    let list = roots;
    let prefix = '';

    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let node = nodes.get(prefix);

      if (!node) {
        node = {name: segment, path: prefix, kind: doc.kind, depth: index, children: []};
        nodes.set(prefix, node);
        list.push(node);
      }

      if (index === segments.length - 1) {
        node.doc = doc;
      }

      list = node.children;
    });
  }

  // source 在前：界面主要给用户看，用户关心的是自己定下的东西。
  const layerOrder: Record<DocKind, number> = {source: 0, derived: 1};
  const sortNodes = (list: TreeNode[]): TreeNode[] =>
    list.sort((a, b) => {
      const layer = layerOrder[a.kind] - layerOrder[b.kind];

      if (a.depth === 0 && layer !== 0) {
        return layer;
      }

      // 文件夹排在文件前面：先扫结构，再看具体是哪篇。
      const folder = (a.doc ? 1 : 0) - (b.doc ? 1 : 0);
      return folder !== 0 ? folder : a.name.localeCompare(b.name);
    });

  sortNodes(roots);

  for (const node of nodes.values()) {
    if (node.children.length > 0) {
      sortNodes(node.children);
    }
  }

  return roots;
}

/** 树里一共有多少篇文档。 */
export function countDocs(node: TreeNode): number {
  return node.doc ? 1 : node.children.reduce((sum, child) => sum + countDocs(child), 0);
}

/** 按树的顺序把文档拉平，用于上下键切换。 */
export function flattenTree(nodes: TreeNode[]): DocMeta[] {
  const list: DocMeta[] = [];

  const walk = (current: TreeNode[]): void => {
    for (const node of current) {
      if (node.doc) {
        list.push(node.doc);
      } else {
        walk(node.children);
      }
    }
  };

  walk(nodes);
  return list;
}

/** 文档标题旁边那个文件名：`source/a/b` → `b.md`。 */
export function fileName(id: string): string {
  return `${id.split('/').pop() ?? id}.md`;
}
