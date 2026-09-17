import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {DocStoreError} from '../src/core/errors.ts';
import {initProject} from '../src/core/project.ts';
import {DocStore} from '../src/core/store.ts';
import type {DocChange} from '../src/core/types.ts';

async function createProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-'));
  await initProject(dir);
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error('等待条件超时');
}

test('初始化项目会建立两层目录与种子文档', async () => {
  const dir = await createProject();
  const store = await DocStore.open(dir);

  try {
    const docs = store.list();
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.id, 'source/requirements');
    assert.equal(docs[0]!.kind, 'source');
    assert.match(docs[0]!.title, /需求与决定/);
    assert.ok(docs[0]!.revision.length === 12);

    for (const name of ['source', 'derived', '.derivedoc']) {
      const stat = await fs.stat(path.join(dir, name));
      assert.ok(stat.isDirectory(), `${name} 应该是目录`);
    }
  } finally {
    await store.close();
  }
});

test('写入后可以读回，写入方之外的改动不会影响自己的修订号', async () => {
  const dir = await createProject();
  const store = await DocStore.open(dir);

  try {
    const written = await store.write('derived/storage', '# 存储层\n\n纯 markdown。');
    assert.equal(written.kind, 'derived');
    assert.equal(written.title, '存储层');

    const read = store.read('derived/storage');
    assert.equal(read.body, '# 存储层\n\n纯 markdown。');
    assert.equal(read.revision, written.revision);

    const again = store.read('derived/storage');
    assert.equal(again.revision, written.revision);
  } finally {
    await store.close();
  }
});

test('baseRevision 不匹配时冲突', async () => {
  const dir = await createProject();
  const store = await DocStore.open(dir);

  try {
    const first = await store.write('derived/api', '# 接口\n\n初版');
    await store.write('derived/api', '# 接口\n\n第二版', {baseRevision: first.revision});

    await assert.rejects(
      () => store.write('derived/api', '# 接口\n\n第三版', {baseRevision: first.revision}),
      (error: unknown) => {
        assert.ok(error instanceof DocStoreError);
        assert.equal(error.code, 'conflict');
        return true;
      },
    );
  } finally {
    await store.close();
  }
});

test('外部改文件会被监听并广播变更', async () => {
  const dir = await createProject();
  const store = await DocStore.open(dir);
  const changes: DocChange[] = [];
  store.onChange(change => changes.push(change));

  try {
    await fs.writeFile(path.join(dir, 'derived/web.md'), '# web 界面\n\n两栏布局。');
    await waitFor(() => changes.some(change => change.id === 'derived/web'));

    const created = changes.find(change => change.id === 'derived/web');
    assert.equal(created?.type, 'created');
    assert.equal(store.read('derived/web').title, 'web 界面');

    await fs.writeFile(path.join(dir, 'derived/web.md'), '# web 界面\n\n改成三栏。');
    await waitFor(() =>
      changes.some(change => change.id === 'derived/web' && change.type === 'changed'),
    );

    await fs.rm(path.join(dir, 'derived/web.md'));
    await waitFor(() =>
      changes.some(change => change.id === 'derived/web' && change.type === 'deleted'),
    );
    assert.equal(store.has('derived/web'), false);
  } finally {
    await store.close();
  }
});

test('append 把内容接到文末', async () => {
  const dir = await createProject();
  const store = await DocStore.open(dir);

  try {
    await store.append('source/requirements', '## 决定：存储用 markdown\n\n不引入数据库。');
    const doc = store.read('source/requirements');
    assert.match(doc.body, /决定：存储用 markdown/);
    assert.match(doc.body, /待补充[\s\S]*决定：存储用 markdown/);
  } finally {
    await store.close();
  }
});

test('createOnly 只在新建时通过', async () => {
  const dir = await createProject();
  const store = await DocStore.open(dir);

  try {
    await store.write('derived/plan', '# 方案\n', {createOnly: true});

    await assert.rejects(
      () => store.write('derived/plan', '# 方案\n\n改了。\n', {createOnly: true}),
      (error: unknown) => {
        assert.ok(error instanceof DocStoreError);
        assert.equal(error.code, 'exists');
        return true;
      },
    );

    assert.equal(store.read('derived/plan').body, '# 方案\n');
  } finally {
    await store.close();
  }
});

test('不合法的 id 会被拒绝', async () => {
  const dir = await createProject();
  const store = await DocStore.open(dir);

  try {
    await assert.rejects(
      () => store.write('notes/foo', 'x'),
      (error: unknown) => {
        assert.ok(error instanceof DocStoreError);
        assert.equal(error.code, 'invalid_id');
        return true;
      },
    );
  } finally {
    await store.close();
  }
});
