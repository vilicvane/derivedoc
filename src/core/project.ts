import fs from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_DIRS = ['source', 'derived', '.derivedoc'] as const;

/** 工作区标记目录：只由 derivedoc 建立，用它区分「这个目录属于 dd 项目」。 */
export const PROJECT_MARKER = '.derivedoc';

const SOURCE_SEED = `# 需求与决定

这里记录用户提出的内容，以及讨论后决定的方向。只写决定，不写推导过程。

## 待补充

还没有写下任何决定。
`;

export interface InitResult {
  created: string[];
  existed: boolean;
}

/** 初始化项目目录结构；已存在的内容不动，只补缺。 */
export async function initProject(root: string): Promise<InitResult> {
  const created: string[] = [];
  let existed = false;
  let sourceCreated = false;

  try {
    const stat = await fs.stat(root);
    existed = stat.isDirectory();
  } catch {
    await fs.mkdir(root, {recursive: true});
  }

  for (const dir of PROJECT_DIRS) {
    const target = path.join(root, dir);

    try {
      await fs.mkdir(target);
      created.push(`${dir}/`);

      if (dir === 'source') {
        sourceCreated = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  // 运行时数据不进版本库：.derivedoc 下的内容默认对 git 不可见。
  try {
    await fs.writeFile(path.join(root, '.derivedoc', '.gitignore'), '*\n', {flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  const seedPath = path.join(root, 'source', 'requirements.md');

  // 只在项目初次建立时种一篇占位文档；用户删掉之后不再自动补回来。
  if (!sourceCreated) {
    return {created, existed};
  }

  try {
    await fs.writeFile(seedPath, SOURCE_SEED, {flag: 'wx'});
    created.push('source/requirements.md');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  return {created, existed};
}

/** 从 dir 往上找最近的 derivedoc 工作区，找不到返回 undefined。 */
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
