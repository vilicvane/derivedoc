import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {initProject} from '../src/core/project.ts';
import {clearSelection, readSelection, writeSelection} from '../src/core/selection.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli/main.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function dd(args: string[], cwd: string): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {cwd, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', code => resolve({stdout, stderr, code: code ?? 0}));
    child.stdin.end();
  });
}

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-selection-'));
  await initProject(root, path.join(root, 'ddoc'));
  return root;
}

test('选区写在项目根下，读得回也清得掉', async () => {
  const root = await createProject();

  assert.equal(await readSelection(root), undefined);

  await writeSelection(root, {
    doc: 'source/interfaces',
    from: 10,
    to: 12,
    quote: '工作区分两处。',
    revision: 'abc123',
    at: '2026-09-18T00:00:00.000Z',
    channel: 'web',
  });

  const selection = await readSelection(root);
  assert.equal(selection?.doc, 'source/interfaces');
  assert.equal(selection?.from, 10);
  assert.equal(selection?.quote, '工作区分两处。');
  // 运行时数据不进版本库。
  assert.equal(await fs.readFile(path.join(root, '.derivedoc/.gitignore'), 'utf8'), '*\n');

  await clearSelection(root);
  assert.equal(await readSelection(root), undefined);
});

test('内容空掉的选区当作没有', async () => {
  const root = await createProject();

  await writeSelection(root, {
    doc: 'source/interfaces',
    from: 1,
    to: 1,
    quote: '   ',
    at: '2026-09-18T00:00:00.000Z',
    channel: 'web',
  });

  assert.equal(await readSelection(root), undefined);
});

test('dd selection 打印选中内容，没有时退出码 1', async () => {
  const root = await createProject();

  const empty = await dd(['selection'], root);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /没有选中内容/);
  assert.deepEqual(JSON.parse((await dd(['selection', '--json'], root)).stdout), {selection: null});

  await writeSelection(root, {
    doc: 'derived/cli',
    from: 3,
    to: 4,
    quote: 'dd [<项目根>=.] [--doc-dir=<文档目录>]',
    revision: 'def456',
    at: '2026-09-18T00:00:00.000Z',
    channel: 'web',
  });

  const printed = await dd(['selection'], root);
  assert.equal(printed.code, 0);
  assert.match(printed.stdout, /derived\/cli\t第 3–4 行\trevision def456/);
  assert.match(printed.stdout, /dd \[<项目根>=\.\]/);

  const json = JSON.parse((await dd(['selection', '--json'], root)).stdout);
  assert.equal(json.doc, 'derived/cli');
  assert.equal(json.to, 4);
});
