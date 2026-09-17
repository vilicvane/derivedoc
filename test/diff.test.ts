import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffLines,
  formatSummary,
  parseGitDiff,
  summarizeDiff,
} from '../src/core/diff.ts';

test('相同内容没有差异', () => {
  const lines = diffLines('a\nb\n', 'a\nb\n');
  assert.deepEqual(summarizeDiff(lines), {added: 0, removed: 0});
  assert.equal(formatSummary(summarizeDiff(lines)), '无变化');
});

test('追加与删除各算各的', () => {
  const lines = diffLines('a\nb\n', 'a\nb\nc\n');
  assert.deepEqual(summarizeDiff(lines), {added: 1, removed: 0});
  assert.deepEqual(
    lines.map(line => `${line.type[0]}:${line.text}`),
    ['s:a', 's:b', 'a:c', 's:'],
  );

  const removed = diffLines('a\nb\nc\n', 'a\nc\n');
  assert.deepEqual(summarizeDiff(removed), {added: 0, removed: 1});
});

test('改动中间一行只报一行增一行删', () => {
  const lines = diffLines('# 标题\n\n旧内容\n\n尾部\n', '# 标题\n\n新内容\n\n尾部\n');
  assert.deepEqual(summarizeDiff(lines), {added: 1, removed: 1});
});

test('顺序保持一致，能直接渲染', () => {
  const types = diffLines('a\nb\n', 'b\na\n').map(line => line.type);
  assert.deepEqual(types, ['remove', 'same', 'add', 'same']);
});

test('git diff 输出能解析成可渲染行', () => {
  const text = [
    'diff --git a/source/a.md b/source/a.md',
    'index 111..222 100644',
    '--- a/source/a.md',
    '+++ b/source/a.md',
    '@@ -1,3 +1,3 @@',
    ' # 标题',
    '-旧内容',
    '+新内容',
    ' 尾部',
  ].join('\n');

  const lines = parseGitDiff(text);
  assert.deepEqual(summarizeDiff(lines), {added: 1, removed: 1});
  assert.deepEqual(
    lines.map(line => `${line.type[0]}:${line.text}`),
    ['s:@@ -1,3 +1,3 @@', 's:# 标题', 'r:旧内容', 'a:新内容', 's:尾部'],
  );
});
