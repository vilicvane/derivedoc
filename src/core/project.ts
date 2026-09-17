import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {DEFAULT_DOCS_DIR} from './defaults.ts';

export {DEFAULT_DOCS_DIR};

/** 工作区标记目录：只由 derivedoc 建立，用它区分「这个目录属于 dd 项目」。 */
export const PROJECT_MARKER = '.derivedoc';

/** 项目根里记文档目录的文件，相对 `.derivedoc/`。 */
const CONFIG_FILE = 'config.json';

/** 两层文档的目录名。 */
const LAYERS = ['source', 'derived'] as const;

/**
 * 一个工作区分两处：项目根放 `.derivedoc/`（运行数据、git 作用域），文档目录放
 * `source/` 与 `derived/`。两者可以是同一个目录，也可以像我们这样根在仓库、文档在 prd/。
 */
export interface WorkspacePaths {
  /** 项目根：`.derivedoc/` 所在，也是 git 作用域。 */
  root: string;
  /** 文档目录：`source/` 与 `derived/` 所在。 */
  docs: string;
}

export interface ResolvedWorkspace extends WorkspacePaths {
  /** 项目根已经存在（带 `.derivedoc/`），还是这一对路径还没建过。 */
  exists: boolean;
  /** 文档目录是从项目配置里读出来的。 */
  recorded: boolean;
}

const SOURCE_SEED = `# 需求与决定

这里记录用户提出的内容，以及讨论后决定的方向。只写决定，不写推导过程。

## 待补充

还没有写下任何决定。
`;

export interface InitResult {
  created: string[];
  existed: boolean;
}

/** 初始化工作区；已存在的内容不动，只补缺。docs 缺省表示文档目录就是项目根。 */
export async function initProject(root: string, docs?: string): Promise<InitResult> {
  const rootDir = path.resolve(root);
  const docsDir = path.resolve(rootDir, docs ?? '.');
  const created: string[] = [];
  let existed = false;
  let sourceCreated = false;

  if (rootDir === path.resolve(os.homedir())) {
    throw new Error('不把家目录当工作区：请在具体项目目录里跑 dd');
  }

  try {
    const stat = await fs.stat(rootDir);
    existed = stat.isDirectory();
  } catch {
    await fs.mkdir(rootDir, {recursive: true});
  }

  // 文档目录可能是一层新子目录（比如项目根下的 prd/）。
  if (docsDir !== rootDir) {
    try {
      await fs.stat(docsDir);
    } catch {
      await fs.mkdir(docsDir, {recursive: true});
      created.push(`${path.relative(rootDir, docsDir)}/`);
    }
  }

  // 文档目录里的两层：这是用户会在界面上看到、也会跟着 git 走的东西。
  for (const dir of ['source', 'derived']) {
    const target = path.join(docsDir, dir);

    try {
      await fs.mkdir(target);
      created.push(`${path.relative(rootDir, target)}/`);

      if (dir === 'source') {
        sourceCreated = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  const markerDir = path.join(rootDir, PROJECT_MARKER);

  try {
    await fs.mkdir(markerDir);
    created.push(`${PROJECT_MARKER}/`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  // 运行时数据不进版本库：.derivedoc 下的内容默认对 git 不可见。
  try {
    await fs.writeFile(path.join(markerDir, '.gitignore'), '*\n', {flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  // 文档目录只在建工作区时记一次；之后由显式指定目录的调用改写。
  try {
    await fs.writeFile(
      path.join(markerDir, CONFIG_FILE),
      `${JSON.stringify({docs: path.relative(rootDir, docsDir) || '.'}, null, 2)}\n`,
      {flag: 'wx'},
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  const seedPath = path.join(docsDir, 'source', 'requirements.md');

  // 只在项目初次建立时种一篇占位文档；用户删掉之后不再自动补回来。
  if (!sourceCreated) {
    return {created, existed};
  }

  try {
    await fs.writeFile(seedPath, SOURCE_SEED, {flag: 'wx'});
    created.push(path.relative(rootDir, seedPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  return {created, existed};
}

/** 项目根里记下的文档目录；没记过或读不出来时返回 undefined。 */
export async function readDocsDir(root: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(root, PROJECT_MARKER, CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw) as {docs?: unknown};

    if (typeof parsed.docs !== 'string' || !parsed.docs.trim()) {
      return undefined;
    }

    return path.resolve(root, parsed.docs);
  } catch {
    return undefined;
  }
}

/** 记下这个项目用哪个文档目录。显式给了目录的调用（`dd ./prd`）会改写它。 */
export async function writeDocsDir(root: string, docs: string): Promise<void> {
  const resolved = path.resolve(root);

  await fs.mkdir(path.join(resolved, PROJECT_MARKER), {recursive: true});
  await fs.writeFile(
    path.join(resolved, PROJECT_MARKER, CONFIG_FILE),
    `${JSON.stringify({docs: path.relative(resolved, path.resolve(docs)) || '.'}, null, 2)}\n`,
    'utf8',
  );
}

export async function isProjectRoot(dir: string): Promise<boolean> {
  // 家目录也是用户级注册表的所在，不把整个家当项目——一个向上查找就能毁掉一切。
  if (path.resolve(dir) === path.resolve(os.homedir())) {
    return false;
  }

  try {
    return (await fs.stat(path.join(path.resolve(dir), PROJECT_MARKER))).isDirectory();
  } catch {
    return false;
  }
}

/** 这个项目根里的文档目录：显式给的 > 记下的 > 老布局（两层就在根下）> 默认 `ddoc/`。 */
export async function docsDirFor(root: string, explicit?: string): Promise<string> {
  if (explicit) {
    return path.resolve(root, explicit);
  }

  const recorded = await readDocsDir(root);

  if (recorded) {
    return recorded;
  }

  for (const layer of LAYERS) {
    try {
      if ((await fs.stat(path.join(root, layer))).isDirectory()) {
        return path.resolve(root);
      }
    } catch {
      // 继续看下一层。
    }
  }

  return path.join(path.resolve(root), DEFAULT_DOCS_DIR);
}

/** 从 dir 往上找最近的项目根，找不到返回 undefined。 */
export async function findProjectRoot(dir: string): Promise<string | undefined> {
  let current = path.resolve(dir);

  for (;;) {
    if (await isProjectRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/**
 * 解析已有工作区：项目根 + 文档目录。
 *
 * input 默认是 cwd。它不是项目根时向上找最近的那个——在项目的子目录里敲 dd 也应该能用；
 * 但显式给了文档目录时不做这种猜测：给的是哪一对就是哪一对，免得在别处误开上层项目。
 * 没命中就按「这一对还没建过」返回，由调用方决定要不要建。
 */
export async function describeWorkspace(
  input: string,
  docDir?: string,
  options: {cwd?: string} = {},
): Promise<ResolvedWorkspace> {
  const cwd = options.cwd ?? process.cwd();
  let root = path.resolve(cwd, input);
  let exists = await isProjectRoot(root);

  if (!exists && !docDir) {
    const enclosing = await findProjectRoot(root);

    if (enclosing) {
      root = enclosing;
      exists = true;
    }
  }

  const recorded = docDir ? undefined : await readDocsDir(root);
  return {
    root,
    docs: await docsDirFor(root, docDir),
    exists,
    recorded: recorded !== undefined,
  };
}

/** 建工作区：项目根与文档目录都要给，文档目录相对项目根解析。 */
export async function createWorkspace(
  projectDir: string,
  docDir: string = DEFAULT_DOCS_DIR,
  options: {cwd?: string} = {},
): Promise<WorkspacePaths & {init: InitResult}> {
  const root = path.resolve(options.cwd ?? process.cwd(), projectDir);

  if (root === path.resolve(os.homedir())) {
    throw new Error('不把家目录当项目根：请在具体项目目录里建工作区');
  }

  const docs = path.resolve(root, docDir);
  const init = await initProject(root, docs);

  return {root, docs, init};
}
