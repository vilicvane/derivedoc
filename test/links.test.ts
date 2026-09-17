import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {extractLinkIds, resolveDocId} from '../src/core/links.ts';
import {initProject} from '../src/core/project.ts';
import {DocStore} from '../src/core/store.ts';

test('相对链接解析成同一项目内的文档 id', () => {
  assert.equal(resolveDocId('../source/product.md', 'derived/overview'), 'source/product');
  assert.equal(resolveDocId('mvp-plan.md', 'derived/overview'), 'derived/mvp-plan');
  assert.equal(resolveDocId('./cli.md#命令', 'derived/server'), 'derived/cli');
  assert.equal(resolveDocId('/derived/cli.md', 'source/interfaces'), 'derived/cli');
});

test('外链、锚点与越界路径不解析', () => {
  assert.equal(resolveDocId('https://example.com/a.md', 'derived/overview'), undefined);
  assert.equal(resolveDocId('#小节', 'derived/overview'), undefined);
  assert.equal(resolveDocId('../../outside.md', 'derived/overview'), undefined);
  assert.equal(resolveDocId('../tmp/x.md', 'derived/overview'), undefined);
});

test('形状合法但确实不存在的 id 只在存在性判断里被排除', () => {
  // 解析只看形状，存在性由调用方（store 的反查、界面的跳转）判断。
  assert.equal(resolveDocId('notes/x.md', 'derived/overview'), 'derived/notes/x');
});

test('extractLinkIds 去重并按 id 排序', () => {
  const body = [
    '- [b](../source/b.md)',
    '- [a](../source/a.md)',
    '- [b again](../source/b.md#x)',
    '- [外链](https://example.com)',
  ].join('\n');

  assert.deepEqual(extractLinkIds(body, 'derived/x'), ['source/a', 'source/b']);
});

test('代码块与行内代码里的链接不算引用', () => {
  const body = [
    '示例：`[链接](../source/a.md)`',
    '',
    '```md',
    '[链接](../source/b.md)',
    '```',
    '',
    '[真的引用](../source/c.md)',
  ].join('\n');

  assert.deepEqual(extractLinkIds(body, 'derived/x'), ['source/c']);
});

test('store 能算出引用与被引用', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-links-'));
  await initProject(dir);
  const store = await DocStore.open(dir);

  try {
    await store.write('source/decisions', '# 决定\n\n一条决定。');
    await store.write(
      'derived/design',
      '# 方案\n\n**依据**：[决定](../source/decisions.md)\n\n正文。',
    );

    assert.deepEqual(store.read('derived/design').links, ['source/decisions']);
    assert.deepEqual(
      store.backlinks('source/decisions').map(doc => doc.id),
      ['derived/design'],
    );
    assert.deepEqual(store.backlinks('derived/design'), []);
  } finally {
    await store.close();
  }
});
