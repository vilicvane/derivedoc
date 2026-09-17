import fs from 'node:fs/promises';
import path from 'node:path';

/** 工作区标记目录：只由 derivedoc 建立，用它区分「这个目录属于 dd 项目」。 */
export const PROJECT_MARKER = '.derivedoc';

/** 项目根里记文档目录的文件，相对 `.derivedoc/`。 */
const CONFIG_FILE = 'config.json';

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
  try {
    return (await fs.stat(path.join(path.resolve(dir), PROJECT_MARKER))).isDirectory();
  } catch {
    return false;
  }
}

/** 从 dir 往上找最近的项目根，找不到返回 undefined。 */
export async function findProjectRoot(dir: string): Promise<string | undefined> {
  let current = path.resolve(dir);

  for (;;) {
    try {
      const stat = await fs.stat(path.join(current, PROJECT_MARKER));

      if (stat.isDirectory()) {
        return current;
      }
    } catch {
      // 继续往上找。
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
 * 项目根默认是 cwd；它不是项目根时向上找最近的那个——在项目的子目录里敲 dd 也应该能用。
 * 但显式给了文档目录时不做这种猜测：给的是哪一对就是哪一对，免得在别处误开上层项目。
 * 文档目录省略时用项目里记下的那个，没记过就取项目根。
 */
export async function resolveWorkspace(
  projectDir: string,
  docDir?: string,
  options: {cwd?: string} = {},
): Promise<WorkspacePaths | undefined> {
  const cwd = options.cwd ?? process.cwd();
  let root = path.resolve(cwd, projectDir);

  if (!(await isProjectRoot(root))) {
    if (docDir) {
      return undefined;
    }

    const enclosing = await findProjectRoot(root);

    if (!enclosing) {
      return undefined;
    }

    root = enclosing;
  }

  const docs = docDir ? path.resolve(root, docDir) : ((await readDocsDir(root)) ?? root);
  return {root, docs};
}

/**
 * 定位 dir 属于哪个工作区（界面上粘路径时用）：dir 是项目根就用它，否则向上找最近的
 * 项目根，并把 dir 当作文档目录。CLI 不走这条——它要求把两者分清楚。
 */
export async function locateWorkspace(
  dir: string,
  options: {cwd?: string} = {},
): Promise<WorkspacePaths | undefined> {
  const start = path.resolve(options.cwd ?? process.cwd(), dir);

  if (await isProjectRoot(start)) {
    return {root: start, docs: (await readDocsDir(start)) ?? start};
  }

  const root = await findProjectRoot(start);
  return root ? {root, docs: start} : undefined;
}

/** 建工作区：项目根与文档目录都要给，文档目录相对项目根解析。 */
export async function createWorkspace(
  projectDir: string,
  docDir: string,
  options: {cwd?: string} = {},
): Promise<WorkspacePaths & {init: InitResult}> {
  const root = path.resolve(options.cwd ?? process.cwd(), projectDir);
  const docs = path.resolve(root, docDir);
  const init = await initProject(root, docs);

  return {root, docs, init};
}
