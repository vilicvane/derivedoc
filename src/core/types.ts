export type DocKind = 'source' | 'derived';

export interface DocMeta {
  /** 文档标识，等于相对路径去掉 .md，例如 source/mvp-scope。 */
  id: string;
  kind: DocKind;
  title: string;
  /** 相对项目根的路径，例如 source/mvp-scope.md。 */
  relPath: string;
  /** 绝对路径。 */
  path: string;
  /** 内容哈希，用于乐观并发与变更判定。 */
  revision: string;
  /** 文件最后修改时间，仅用于展示与排序。 */
  updatedAt: string;
  size: number;
  /** 正文里指向其它文档的链接（已解析成文档 id）。 */
  links: string[];
}

export interface Doc extends DocMeta {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface DocChange {
  type: 'created' | 'changed' | 'deleted';
  id: string;
  kind: DocKind;
  revision: string;
  updatedAt: string;
}
