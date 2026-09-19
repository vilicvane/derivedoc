#!/usr/bin/env node
// 源码仓库的 Codex 钩子入口。发布后的项目通过 `derivedoc hook codex-prompt-submit`
// 走同一份实现；这个薄包装只用于 derivedoc 自己 dogfood。

import path from 'node:path';

import {runCodexPromptSubmit} from '../../src/hooks/codex.ts';

await runCodexPromptSubmit({
  workspaceRoot: process.argv[2] || undefined,
  cliEntry: path.resolve(import.meta.dirname, '../../src/cli/main.ts'),
});
