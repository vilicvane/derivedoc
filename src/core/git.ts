import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface GitChange {
  path: string;
  /** 暂存区状态，例如 M、A、D、? */
  index: string;
  /** 工作区状态 */
  worktree: string;
  /** 相对 HEAD 的新增行数（未跟踪文件按整篇算） */
  added?: number;
  /** 相对 HEAD 的删除行数 */
  removed?: number;
}

export interface GitStatus {
  available: boolean;
  reason?: string;
  branch?: string;
  changes: GitChange[];
  /** 待提交的 commit message（存在 .derivedoc/commit-message 里） */
  message?: string;
  /** 工作区里不属于两层文档、但同样未提交的条目数（代码等） */
  otherChanges: number;
}

export interface GitCommitResult {
  ok: boolean;
  sha?: string;
  error?: string;
}

const MESSAGE_FILE = '.derivedoc/commit-message';

/** 只跟踪两层文档；项目里的其它内容不归这个工具管。 */
const LAYERS = ['source', 'derived'];

/** 文档目录相对项目根的路径（项目根就是文档目录时为空串）。 */
function docsRel(root: string, docs: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(docs)).replace(/\\/g, '/');
  return rel === '.' ? '' : rel;
}

/** git 命令里的作用域：`prd/source`、`prd/derived` 这样带文档目录前缀。 */
function scopesOf(root: string, docs: string): string[] {
  const rel = docsRel(root, docs);
  return LAYERS.map(layer => (rel ? `${rel}/${layer}` : layer));
}

/** 输出里的路径前缀：仓库前缀 + 文档目录前缀，剥掉它才能拿到 `source/…` 这样的文档路径。 */
async function docsPrefix(root: string, docs: string): Promise<string> {
  const rel = docsRel(root, docs);
  return `${await repoPrefix(root)}${rel ? `${rel}/` : ''}`;
}

/** 文档路径（`source/x.md`）→ 项目根下的路径（`prd/source/x.md`）。 */
function filePathOf(root: string, docs: string, file: string): string {
  const rel = docsRel(root, docs);
  return rel ? `${rel}/${file}` : file;
}

function run(root: string, args: string[]): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['-C', root, ...args],
      {maxBuffer: 32 * 1024 * 1024, encoding: 'utf8'},
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as NodeJS.ErrnoException & {code?: number}).code ?? 1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          ...(typeof (error as {code?: unknown})?.code === 'number'
            ? {code: (error as unknown as {code: number}).code}
            : {}),
        });
      },
    );
  });
}

export async function gitStatus(root: string, docs: string): Promise<GitStatus> {
  const inside = await run(root, ['rev-parse', '--is-inside-work-tree']);

  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return {available: false, reason: '这个目录不在 git 仓库里', changes: [], otherChanges: 0};
  }

  const scopes = scopesOf(root, docs);
  const [branch, status, message, prefix, overall] = await Promise.all([
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(root, ['status', '--porcelain', '--untracked-files=all', '--', ...scopes]),
    readMessage(root),
    docsPrefix(root, docs),
    // 目录不展开，否则 node_modules 会撑出几千条。
    run(root, ['status', '--porcelain', '--', '.']),
  ]);

  const changes = parsePorcelain(status.stdout, prefix);
  await attachLineStats(root, changes, prefix, scopes);
  const otherChanges = parsePorcelain(overall.stdout, prefix).filter(
    change => !isDocPath(change.path),
  ).length;

  return {
    available: true,
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    changes,
    message,
    otherChanges,
  };
}

/** 路径是相对文档目录的，所以这里只比两层名字。 */
function isDocPath(relPath: string): boolean {
  return LAYERS.some(layer => relPath === layer || relPath.startsWith(`${layer}/`));
}

/** 给每个变更文件补上 +/− 行数，方便批量审阅时先扫一眼大小。 */
async function attachLineStats(
  root: string,
  changes: GitChange[],
  prefix: string,
  scopes: string[],
): Promise<void> {
  const numstat = await run(root, ['diff', '--numstat', 'HEAD', '--', ...scopes]);

  for (const line of numstat.stdout.split('\n')) {
    const [added, removed, ...rest] = line.split('\t');
    const raw = rest.join('\t').trim();

    if (!raw) {
      continue;
    }

    const relPath = (prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw).replace(
      /\/$/,
      '',
    );
    const change = changes.find(item => item.path === relPath);

    if (change) {
      change.added = Number(added);
      change.removed = Number(removed);
    }
  }

  // 未跟踪的新文件不在 diff 里，直接数行数。
  for (const change of changes) {
    if (change.added !== undefined || change.index !== '?') {
      continue;
    }

    const body = await fs.readFile(path.join(root, change.path), 'utf8').catch(() => '');
    change.added = body ? body.split('\n').length : 0;
    change.removed = 0;
  }
}

export async function gitDiff(
  root: string,
  docs: string,
  file?: string,
  base: 'head' | 'index' = 'head',
): Promise<string> {
  const scopes = scopesOf(root, docs);
  const scoped = file ? ['--', filePathOf(root, docs, file)] : ['--', ...scopes];
  const hasHead = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  // base=head：已提交版本 ↔ 工作区；base=index：暂存区 ↔ 工作区。
  const result =
    base === 'index'
      ? await run(root, ['diff', '--no-color', '--text', ...scoped])
      : hasHead
        ? await run(root, ['diff', '--no-color', '--text', 'HEAD', ...scoped])
        : {code: 0, stdout: '', stderr: ''};

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git diff 失败');
  }

  // 未跟踪的新文件不在 diff 里，补一份“全新增”的展示。
  const untracked = base === 'index'
    ? {code: 0, stdout: '', stderr: ''}
    : hasHead
    ? await run(root, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        ...(file ? [filePathOf(root, docs, file)] : scopes),
      ])
    : await run(root, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...(file ? [filePathOf(root, docs, file)] : scopes),
      ]);

  for (const line of untracked.stdout.split('\n')) {
    const raw = line.trim();
    const prefix = await docsPrefix(root, docs);
    const relPath = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;

    if (!relPath || !relPath.endsWith('.md')) {
      continue;
    }

    const body = await fs.readFile(path.resolve(root, docsRel(root, docs), relPath), 'utf8').catch(
      () => '',
    );
    result.stdout += `\ndiff --git a/${relPath} b/${relPath}\nnew file\n${body
      .split('\n')
      .map(text => `+${text}`)
      .join('\n')}\n`;
  }

  return result.stdout;
}

/** HEAD（或指定 rev）里的文件内容；文件不在该版本里时返回空串。 */
export async function gitShow(root: string, docs: string, file: string, rev = 'HEAD'): Promise<string> {
  const result = await run(root, ['show', `${rev}:${(await docsPrefix(root, docs)) + file}`]);
  return result.code === 0 ? result.stdout : '';
}

/** 暂存指定范围（缺省是两层文档整体）。 */
export async function gitStage(root: string, docs: string, file?: string): Promise<void> {
  const targets = file ? [filePathOf(root, docs, file)] : await existingScopes(root, docs);

  if (targets.length === 0) {
    return;
  }

  const result = await run(root, ['add', '--', ...targets]);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git add 失败');
  }
}

/** 取消暂存（保留工作区改动）。 */
export async function gitUnstage(root: string, docs: string, file?: string): Promise<void> {
  const targets = file ? [filePathOf(root, docs, file)] : await existingScopes(root, docs);

  if (targets.length === 0) {
    return;
  }

  const result = await run(root, ['restore', '--staged', '--', ...targets]);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git restore --staged 失败');
  }
}

/** 只把真正有内容的层交给 git：空目录会让 git 报 pathspec 找不到。 */
async function existingScopes(root: string, docs: string): Promise<string[]> {
  const rel = docsRel(root, docs);
  const [status, prefix] = await Promise.all([
    run(root, ['status', '--porcelain', '--untracked-files=all', '--', ...scopesOf(root, docs)]),
    docsPrefix(root, docs),
  ]);
  const present = new Set(
    parsePorcelain(status.stdout, prefix).map(change => change.path.split('/')[0] ?? ''),
  );

  return LAYERS.filter(layer => present.has(layer)).map(layer =>
    rel ? `${rel}/${layer}` : layer,
  );
}

/** 暂存区里的文件内容；没有暂存过时返回空串。 */
export async function gitShowStaged(root: string, docs: string, file: string): Promise<string> {
  return gitShow(root, docs, file, ':0');
}

export async function hasCommits(root: string): Promise<boolean> {
  return (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
}

export async function gitCommit(
  root: string,
  docs: string,
  message: string,
): Promise<GitCommitResult> {
  const trimmed = message.trim();

  if (!trimmed) {
    return {ok: false, error: 'commit message 是空的'};
  }

  // 只处理真正有改动的层：git commit 的 pathspec 必须匹配已知路径，空目录会直接报错。
  const scopes = scopesOf(root, docs);
  const [status, prefix] = await Promise.all([
    run(root, ['status', '--porcelain', '--untracked-files=all', '--', ...scopes]),
    docsPrefix(root, docs),
  ]);
  const staged = parsePorcelain(status.stdout, prefix).filter(
    change => change.index !== ' ' && change.index !== '?',
  );

  if (staged.length === 0) {
    return {ok: false, error: '还没有暂存任何文档改动'};
  }

  const targets = [
    ...new Set(
      staged
        .map(change => change.path.split('/')[0] ?? '')
        .filter(layer => (LAYERS as readonly string[]).includes(layer)),
    ),
  ].map(layer => filePathOf(root, docs, layer));

  // 只提交已经暂存的内容：不替用户 add，交什么由 stage 决定。
  const commit = await run(root, ['commit', '-m', trimmed, '--', ...targets]);

  if (commit.code !== 0) {
    return {ok: false, error: (commit.stderr || commit.stdout).trim() || 'git commit 失败'};
  }

  const sha = await run(root, ['rev-parse', '--short', 'HEAD']);
  await writeMessage(root, '');

  return {ok: true, sha: sha.stdout.trim()};
}

export async function readMessage(root: string): Promise<string> {
  return fs.readFile(path.join(root, MESSAGE_FILE), 'utf8').catch(() => '');
}

export async function writeMessage(root: string, message: string): Promise<void> {
  const file = path.join(root, MESSAGE_FILE);

  if (!message) {
    await fs.rm(file, {force: true});
    return;
  }

  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, message.endsWith('\n') ? message : `${message}\n`, 'utf8');
}

export function parsePorcelain(output: string, prefix = ''): GitChange[] {
  const changes: GitChange[] = [];

  for (const line of output.split('\n')) {
    if (line.length < 4) {
      continue;
    }

    const index = line[0]!;
    const worktree = line[1]!;
    const raw = line.slice(3).trim();
    const target = raw.includes(' -> ') ? raw.split(' -> ')[1]! : raw;
    const relPath = (prefix && target.startsWith(prefix) ? target.slice(prefix.length) : target)
      .replace(/\/$/, '');

    changes.push({path: relPath, index, worktree});
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** 工作区相对仓库根的路径前缀（工作区就是仓库根时为空串）。 */
async function repoPrefix(root: string): Promise<string> {
  const result = await run(root, ['rev-parse', '--show-prefix']);
  return result.code === 0 ? result.stdout.trim() : '';
}
