import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createWorkspace,
  DEFAULT_DOCS_DIR,
  describeWorkspace,
  initProject,
  readDocsDir,
} from '../src/core/project.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli/main.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function dd(args: string[], options: {input?: string; cwd?: string} = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.cwd ? {cwd: options.cwd} : {}),
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', code => resolve({stdout, stderr, code: code ?? 0}));
    child.stdin.end(options.input ?? '');
  });
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-project-'));
}

test('项目根放 .derivedoc，文档目录放两层文档', async () => {
  const root = await tempDir();
  const docs = path.join(root, 'prd');

  await initProject(root, docs);

  assert.equal((await fs.stat(path.join(root, '.derivedoc'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(docs, 'source'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(docs, 'derived'))).isDirectory(), true);
  assert.equal(await readDocsDir(root), docs);

  // 项目根不该冒出两层文档。
  await assert.rejects(fs.stat(path.join(root, 'source')));
});

test('describeWorkspace：不带 --doc-dir 时用项目里记下的', async () => {
  const dir = await tempDir();
  await initProject(dir);

  assert.deepEqual(await describeWorkspace(dir), {
    root: dir,
    docs: dir,
    exists: true,
    recorded: true,
  });
  assert.deepEqual(await describeWorkspace(dir, 'prd'), {
    root: dir,
    docs: path.join(dir, 'prd'),
    exists: true,
    recorded: false,
  });
});

test('describeWorkspace：还没建过时给默认文档目录，位置仍按给的来', async () => {
  const dir = await tempDir();

  assert.deepEqual(await describeWorkspace(dir), {
    root: dir,
    docs: path.join(dir, DEFAULT_DOCS_DIR),
    exists: false,
    recorded: false,
  });
  assert.deepEqual(await describeWorkspace(dir, 'prd'), {
    root: dir,
    docs: path.join(dir, 'prd'),
    exists: false,
    recorded: false,
  });
});

test('describeWorkspace：给的目录在项目里时向上找项目根，文档目录仍以项目记下的为准', async () => {
  const root = await tempDir();
  const docs = path.join(root, 'prd');
  await initProject(root, docs);

  assert.deepEqual(await describeWorkspace(docs), {root, docs, exists: true, recorded: true});
  assert.deepEqual(await describeWorkspace(root), {root, docs, exists: true, recorded: true});
  assert.deepEqual(await describeWorkspace('.', undefined, {cwd: root}), {
    root,
    docs,
    exists: true,
    recorded: true,
  });
  // 子目录也一样：认得出所属项目，不会把子目录当成文档目录。
  assert.deepEqual(await describeWorkspace('source', undefined, {cwd: docs}), {
    root,
    docs,
    exists: true,
    recorded: true,
  });
});

test('createWorkspace：文档目录相对项目根', async () => {
  const root = await tempDir();
  const created = await createWorkspace('.', 'prd', {cwd: root});

  assert.deepEqual({root: created.root, docs: created.docs}, {root, docs: path.join(root, 'prd')});
  assert.equal(await readDocsDir(root), path.join(root, 'prd'));
});

test('createWorkspace：项目根可以是别的目录，两者分开', async () => {
  const cwd = await tempDir();
  const project = path.join(cwd, 'app');
  const created = await createWorkspace('app', 'docs/spec', {cwd});

  assert.equal(created.root, project);
  assert.equal(created.docs, path.join(project, 'docs/spec'));
});

test('子命令按项目根定位，config 记下文档目录', async () => {
  const root = await tempDir();
  const docs = path.join(root, 'prd');
  await initProject(root, docs);

  const where = await dd([root, 'root']);
  assert.equal(where.code, 0);
  assert.equal(where.stdout.trim(), root);
  assert.equal(JSON.parse((await dd([root, 'root', '--json'])).stdout).docs, docs);

  const listed = await dd([root, 'ls']);
  assert.match(listed.stdout, /source\/requirements\tsource\t/);

  const written = await dd([root, 'write', 'derived/plan'], {input: '# 方案\n'});
  assert.equal(written.code, 0);
  assert.equal((await fs.readFile(path.join(docs, 'derived', 'plan.md'), 'utf8')).trim(), '# 方案');

  // 显式指定文档目录时以它为准，并覆盖 config：spec 还没建过，所以列不出东西。
  const moved = path.join(root, 'spec');
  const withFlag = await dd([root, '--doc-dir=spec', 'ls']);
  assert.equal(withFlag.code, 0);
  assert.equal(withFlag.stdout, '');
  assert.equal(await readDocsDir(root), moved);

  // 指回原来的目录，内容还在。
  const back = await dd([root, '--doc-dir=prd', 'ls']);
  assert.match(back.stdout, /source\/requirements/);

  // 不存在的项目根会给出「怎么建」的提示。
  const missing = await dd([path.join(await tempDir(), 'nope'), 'ls']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--doc-dir=prd/);
});

test('子命令可以省掉项目根：在项目里直接 dd ls', async () => {
  const root = await tempDir();
  const docs = path.join(root, 'prd');
  await initProject(root, docs);

  const listed = await dd(['ls'], {cwd: root});
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /source\/requirements/);

  const where = await dd(['root', '--json'], {cwd: docs});
  assert.equal(JSON.parse(where.stdout).root, root);

  // 在项目的子目录里也认得出所属项目，文档目录仍以项目记下的为准。
  const nested = await dd([docs, 'ls']);
  assert.equal(nested.code, 0);
  assert.match(nested.stdout, /source\/requirements/);
  assert.equal(JSON.parse((await dd([docs, 'root', '--json'])).stdout).root, root);
});

test('项目根与文档目录都能省：创建时默认 ddoc/', async () => {
  const dir = await tempDir();
  const written = await dd(['write', 'derived/plan'], {input: '# 方案\n', cwd: dir});

  assert.equal(written.code, 0);
  assert.equal(await readDocsDir(dir), path.join(dir, DEFAULT_DOCS_DIR));
  assert.equal((await fs.stat(path.join(dir, '.derivedoc'))).isDirectory(), true);
  assert.equal(
    (await fs.readFile(path.join(dir, DEFAULT_DOCS_DIR, 'derived/plan.md'), 'utf8')).trim(),
    '# 方案',
  );
});

test('指定 --doc-dir 时按指定目录建', async () => {
  const dir = await tempDir();
  const written = await dd(['--doc-dir=prd', 'write', 'derived/plan'], {
    input: '# 方案\n',
    cwd: dir,
  });

  assert.equal(written.code, 0);
  assert.equal(await readDocsDir(dir), path.join(dir, 'prd'));
  assert.equal(
    (await fs.readFile(path.join(dir, 'prd/derived/plan.md'), 'utf8')).trim(),
    '# 方案',
  );
});
