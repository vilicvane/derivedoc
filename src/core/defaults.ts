/**
 * 文档目录的默认名字。创建时没指定就用它，也写进 `.derivedoc/config.json`。
 * 单独放一个纯模块，因为界面也要用，而 `project.ts` 依赖 node:fs。
 */
export const DEFAULT_DOCS_DIR = 'ddoc';
