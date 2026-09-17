import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

import {
  gitCommit,
  gitDiff,
  gitShow,
  gitShowStaged,
  gitStage,
  gitStatus,
  gitUnstage,
  parsePorcelain,
  writeMessage,
} from '../src/core/git.ts';
import {initProject} from '../src/core/project.ts';
import {DocStore} from '../src/core/store.ts';

const exec = promisify(execFile);

async function createRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-git-'));
  const git = (...args: string[]) => exec('git', ['-C', dir, ...args], {encoding: 'utf8'});

  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await initProject(dir);
  await git('add', '--', '.');
  await git('commit', '-q', '-m', 'init');

  return dir;
}

test('parsePorcelain 解析状态与重命名', () => {
  assert.deepEqual(parsePorcelain(' M source/a.md\n?? derived/b.md\nR  a.md -> b.md\n'), [
    {path: 'b.md', index: 'R', worktree: ' '},
    {path: 'derived/b.md', index: '?', worktree: '?'},
    {path: 'source/a.md', index: ' ', worktree: 'M'},
  ]);
});

test('非仓库目录会明确报告不可用', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-nogit-'));
  await initProject(dir);

  const status = await gitStatus(dir);
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /不在 git 仓库/);
});

test('改动后能拿到 diff，提交后工作区干净', async () => {
  const dir = await createRepo();
  const store = await DocStore.open(dir, {watch: false});

  try {
    await store.write('source/decisions', '# 决定\n\n第一条决定。\n');
    const status = await gitStatus(dir);
    assert.equal(status.available, true);
    assert.deepEqual(
      status.changes.map(change => change.path),
      ['source/decisions.md'],
    );

    const diff = await gitDiff(dir);
    assert.match(diff, /\+第一条决定。/);

    const single = await gitDiff(dir, 'source/decisions.md');
    assert.match(single, /\+第一条决定。/);

    await writeMessage(dir, '记录第一条决定');
    const message = (await gitStatus(dir)).message ?? '';
    assert.equal(message.trim(), '记录第一条决定');

    // 先暂存再提交：提交只带已暂存的内容。
    await gitStage(dir, 'source/decisions.md');
    assert.match(await gitShowStaged(dir, 'source/decisions.md'), /第一条决定/);

    const committed = await gitCommit(dir, message);
    assert.equal(committed.ok, true);
    assert.ok(committed.sha);

    const after = await gitStatus(dir);
    assert.deepEqual(after.changes, []);
    assert.equal(after.message, '');

    const log = await exec('git', ['-C', dir, 'log', '-1', '--pretty=%s'], {encoding: 'utf8'});
    assert.equal(log.stdout.trim(), '记录第一条决定');
  } finally {
    await store.close();
  }
});

test('提交只带上两层文档，不动其它暂存内容', async () => {
  const dir = await createRepo();
  await fs.writeFile(path.join(dir, 'other.txt'), 'not a doc\n');

  const git = (...args: string[]) => exec('git', ['-C', dir, ...args], {encoding: 'utf8'});
  await git('add', '--', 'other.txt');

  const store = await DocStore.open(dir, {watch: false});

  try {
    await store.write('source/decisions', '# 决定\n\n只提交文档。\n');
    await gitStage(dir);
    const result = await gitCommit(dir, '只提交文档');
    assert.equal(result.ok, true);

    const staged = await git('diff', '--cached', '--name-only');
    assert.deepEqual(staged.stdout.split('\n').filter(Boolean), ['other.txt']);
  } finally {
    await store.close();
  }
});

test('空 message 拒绝提交', async () => {
  const dir = await createRepo();
  const result = await gitCommit(dir, '   ');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /空的/);
});

test('没暂存就不提交；暂存后可以取消暂存', async () => {
  const dir = await createRepo();
  const store = await DocStore.open(dir, {watch: false});

  try {
    await store.write('source/decisions', '# 决定\n\n还没暂存。\n');

    const refused = await gitCommit(dir, '未暂存');
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /暂存/);

    await gitStage(dir);
    assert.deepEqual(
      (await gitStatus(dir)).changes.map(change => change.index),
      ['A'],
    );
    assert.match(await gitShowStaged(dir, 'source/decisions.md'), /还没暂存/);

    await gitUnstage(dir);
    assert.equal(await gitShowStaged(dir, 'source/decisions.md'), '');
    assert.deepEqual(
      (await gitStatus(dir)).changes.map(change => change.path),
      ['source/decisions.md'],
    );
  } finally {
    await store.close();
  }
});

test('还没有任何提交时也能看 diff', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-fresh-'));
  await exec('git', ['-C', dir, 'init', '-q'], {encoding: 'utf8'});
  await initProject(dir);

  const store = await DocStore.open(dir, {watch: false});

  try {
    await store.write('source/decisions', '# 决定\n\n还没有提交过。\n');

    const status = await gitStatus(dir);
    assert.equal(status.available, true);
    assert.equal(status.branch, undefined);
    assert.ok(status.changes.some(change => change.path === 'source/decisions.md'));

    const diff = await gitDiff(dir);
    assert.match(diff, /\+还没有提交过。/);

    assert.equal(await gitShow(dir, 'source/decisions.md'), '');
  } finally {
    await store.close();
  }
});
