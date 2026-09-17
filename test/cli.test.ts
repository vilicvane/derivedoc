import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {initProject} from '../src/core/project.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli/main.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function dd(args: string[], input?: string): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', code => resolve({stdout, stderr, code: code ?? 0}));
    child.stdin.end(input ?? '');
  });
}

async function createProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-cli-'));
  await initProject(dir);
  return dir;
}

test('ls 列出两层文档', async () => {
  const dir = await createProject();
  const result = await dd([dir, 'ls']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /source\/requirements\tsource\t[0-9a-f]{12}\t需求与决定/);
});

test('write 从 stdin 读内容，read 与 stat 能读回', async () => {
  const dir = await createProject();

  const written = await dd([dir, 'write', 'derived/storage'], '# 存储层\n\n纯 markdown。\n');
  assert.equal(written.code, 0);
  assert.match(written.stdout, /^derived\/storage\t[0-9a-f]{12}\n$/);

  const body = await dd([dir, 'read', 'derived/storage']);
  assert.equal(body.stdout, '# 存储层\n\n纯 markdown。\n');

  const revision = await dd([dir, 'stat', 'derived/storage']);
  assert.match(revision.stdout, /^[0-9a-f]{12}\n$/);
});

test('append 追加到文末', async () => {
  const dir = await createProject();
  await dd([dir, 'append', 'source/requirements', '## 决定：先用 CLI\n\nMCP 先不接。']);

  const body = await dd([dir, 'read', 'source/requirements']);
  assert.match(body.stdout, /决定：先用 CLI/);
});

test('过期 base-revision 会冲突', async () => {
  const dir = await createProject();
  await dd([dir, 'write', 'derived/api'], '# 接口\n\n初版\n');
  const stale = (await dd([dir, 'stat', 'derived/api'])).stdout.trim();
  await dd([dir, 'write', 'derived/api', '--base-revision', stale], '# 接口\n\n第二版\n');

  const conflict = await dd([dir, 'write', 'derived/api', '--base-revision', stale], '# 接口\n\n第三版\n');
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /error\[conflict\]/);
});

test('read --json 带出修订号与 frontmatter', async () => {
  const dir = await createProject();
  await dd([dir, 'write', 'derived/web'], '---\ntitle: web 界面\n---\n\n两栏。\n');

  const result = await dd([dir, 'read', 'derived/web', '--json']);
  const payload = JSON.parse(result.stdout) as {
    id: string;
    title: string;
    revision: string;
    frontmatter: Record<string, unknown>;
    body: string;
  };

  assert.equal(payload.id, 'derived/web');
  assert.equal(payload.title, 'web 界面');
  assert.equal(payload.frontmatter['title'], 'web 界面');
  assert.match(payload.revision, /^[0-9a-f]{12}$/);
  assert.equal(payload.body, '两栏。\n');
});

test('未知子命令给出提示', async () => {
  const dir = await createProject();
  const result = await dd([dir, 'nope']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /未知子命令/);
});

test('root 能定位工作区，深一层目录也算', async () => {
  const dir = await createProject();
  await fs.mkdir(path.join(dir, 'derived/nested'), {recursive: true});

  const hit = await dd([path.join(dir, 'derived/nested'), 'root']);
  assert.equal(hit.code, 0);
  assert.equal(hit.stdout.trim(), await fs.realpath(dir));

  const miss = await dd([os.tmpdir(), 'root']);
  assert.equal(miss.code, 1);
});
