import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCaptureInstruction,
  CODEX_HOOK_COMMAND,
  DEFAULT_PROJECT_INSTRUCTIONS,
} from '../src/hooks/codex.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli/main.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(
  command: string,
  args: string[],
  options: {cwd: string; input?: string; env?: NodeJS.ProcessEnv},
): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', code => resolve({stdout, stderr, code: code ?? 1}));
    child.stdin.end(options.input ?? '');
  });
}

function derivedoc(args: string[], cwd: string): Promise<RunResult> {
  return run(process.execPath, [CLI, ...args], {cwd});
}

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'derivedoc-codex-'));
}

test('init 为全新项目建立文档、项目规则和 Codex 钩子', async () => {
  const root = await tempProject();
  const initialized = await derivedoc(['init', '--json'], root);

  assert.equal(initialized.code, 0, initialized.stderr);
  const result = JSON.parse(initialized.stdout) as {
    root: string;
    docs: string;
    created: string[];
    updated: string[];
  };
  assert.equal(result.root, root);
  assert.equal(result.docs, path.join(root, 'ddoc'));
  assert.ok(result.created.includes('.codex/hooks.json'));
  assert.ok(result.created.includes('DERIVEDOC.md'));

  const hooks = JSON.parse(await fs.readFile(path.join(root, '.codex/hooks.json'), 'utf8')) as {
    hooks: {UserPromptSubmit: Array<{hooks: Array<{command: string}>}>};
  };
  assert.equal(hooks.hooks.UserPromptSubmit[0]!.hooks[0]!.command, CODEX_HOOK_COMMAND);
  assert.equal(await fs.readFile(path.join(root, 'DERIVEDOC.md'), 'utf8'), DEFAULT_PROJECT_INSTRUCTIONS);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, '.derivedoc/config.json'), 'utf8')).docs,
    'ddoc',
  );

  const repeated = await derivedoc(['init', '--json'], root);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).created, []);
  assert.deepEqual(JSON.parse(repeated.stdout).updated, []);
});

test('init 保留已有钩子并支持自定义文档目录', async () => {
  const root = await tempProject();
  await fs.mkdir(path.join(root, '.codex'), {recursive: true});
  await fs.writeFile(
    path.join(root, '.codex/hooks.json'),
    `${JSON.stringify({
      description: 'keep me',
      hooks: {SessionStart: [{hooks: [{type: 'command', command: 'echo existing'}]}]},
    })}\n`,
  );

  const initialized = await derivedoc(['init', '--doc-dir=prd', '--json'], root);
  assert.equal(initialized.code, 0, initialized.stderr);
  const result = JSON.parse(initialized.stdout);
  assert.equal(result.docs, path.join(root, 'prd'));
  assert.deepEqual(result.updated, ['.codex/hooks.json']);

  const hooks = JSON.parse(await fs.readFile(path.join(root, '.codex/hooks.json'), 'utf8'));
  assert.equal(hooks.description, 'keep me');
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, CODEX_HOOK_COMMAND);
});

test('初始化出来的钩子命令输出单个合法 JSON，并注入项目规则', async () => {
  const root = await tempProject();
  assert.equal((await derivedoc(['init'], root)).code, 0);

  const bin = path.join(root, '.test-bin');
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, 'derivedoc'),
    `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`,
  );
  await fs.chmod(path.join(bin, 'derivedoc'), 0o755);

  const hooks = JSON.parse(await fs.readFile(path.join(root, '.codex/hooks.json'), 'utf8'));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command as string;
  const payload = JSON.stringify({
    session_id: 'probe-session',
    turn_id: 'probe-turn',
    cwd: root,
    prompt: '我在考虑是否采用缓存。',
  });
  const executed = await run('/bin/sh', ['-c', command], {
    cwd: root,
    input: payload,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      DERIVEDOC_HOOK_PROBE: '1',
    },
  });

  assert.equal(executed.code, 0, executed.stderr);
  const lines = executed.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]!) as {
    hookSpecificOutput: {hookEventName: string; additionalContext: string};
  };
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /PROBE-MARKER-/);
  assert.match(output.hookSpecificOutput.additionalContext, /TODO 跟随已确认要求的生命周期/);
});

test('捕获提示词先判承诺，再允许文档和 TODO 写入', () => {
  const prompt = buildCaptureInstruction(
    '/tmp/project',
    '我在考虑要不要改架构。',
    '# 项目自定义\n\n只用 ISSUE 跟踪待办。\n',
    CLI,
  );

  assert.match(prompt, /完全不写是正常结果/);
  assert.match(prompt, /只有“已确认”能继续到写入步骤/);
  assert.match(prompt, /TODO 只能在三个条件同时成立时生成/);
  assert.match(prompt, /我在考虑要不要把待办提示词放进项目文档/);
  assert.match(prompt, /只用 ISSUE 跟踪待办/);
});
