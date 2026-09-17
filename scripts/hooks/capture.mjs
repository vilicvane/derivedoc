#!/usr/bin/env node
// derivedoc · 捕获子会话
//
// 输入：Codex UserPromptSubmit 钩子的 payload（stdin）+ 工作区根目录（argv[2]）
// 行为：fork 一个一次性子会话，让它把本条用户消息里的决定写进文档，并把「这条消息意味着
//       什么」的思考过程作为最终回复交回来，落在 .derivedoc/pending/ 供下一步注入。

import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TIMEOUT_MS = Number(process.env.DERIVEDOC_CAPTURE_TIMEOUT ?? 180_000);
const CLI = path.resolve(import.meta.dirname, '../../bld/cli/main.js');

const root = process.argv[2];
const payload = JSON.parse(await readStdin());
const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';

if (!root || !prompt.trim() || !sessionId) {
  process.exit(0);
}

// 只验证钩子的输出通道时用：跳过子会话，直接回一段可辨认的上下文。
if (process.env.DERIVEDOC_HOOK_PROBE) {
  emit(`PROBE-MARKER-${Date.now()}`);
  process.exit(0);
}

const pendingDir = path.join(root, '.derivedoc', 'pending');
await fs.mkdir(pendingDir, {recursive: true});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(pendingDir, `${stamp}-${payload.turn_id ?? 'turn'}.md`);
const logFile = path.join(root, '.derivedoc', 'capture.log');

const before = await listRevisions(root);
const startedAt = Date.now();
const child = spawn(
  'codex',
  [
    'exec',
    'fork',
    sessionId,
    '--ephemeral',
    '--skip-git-repo-check',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    `sandbox_workspace_write.writable_roots=["${root}"]`,
    '-c',
    'approval_policy="never"',
    '-o',
    outFile,
    buildInstruction(root, prompt),
  ],
  {cwd: root, env: {...process.env, DERIVEDOC_CAPTURE: '1'}, stdio: ['ignore', 'pipe', 'pipe']},
);

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => (stderr += chunk));

const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
const code = await new Promise(resolve => child.on('close', resolve));
clearTimeout(timer);

const elapsed = Date.now() - startedAt;
const after = await listRevisions(root);
let thinking = '';

try {
  thinking = (await fs.readFile(outFile, 'utf8')).trim();
} catch {
  // 子会话没写出结果，保持为空。
}

await fs.appendFile(
  logFile,
  `${JSON.stringify({
    at: new Date().toISOString(),
    elapsedMs: elapsed,
    code,
    sessionId,
    prompt: prompt.slice(0, 200),
    thinkingChars: thinking.length,
    stderr: code === 0 ? undefined : stderr.slice(-500),
  })}\n`,
);

if (code !== 0 || !thinking) {
  await fs.rm(outFile, {force: true});
  emit(
    `derivedoc：这条消息的捕获没有产出（退出码 ${code}）。详情见 ${path.relative(root, logFile)}。`,
  );
  process.exit(0);
}

const changed = [...after]
  .filter(([id, revision]) => before.get(id) !== revision)
  .map(([id]) => id);

emit(
  [
    'derivedoc：这条用户消息已经过一轮捕获。',
    `推理过程在 ${path.relative(root, outFile)}（完整但精简，需要时自己读它）。`,
    changed.length > 0
      ? `本轮更新的文档：${changed.join('、')}。`
      : '本轮没有文档变更（这条消息没有产生需要沉淀的决定）。',
  ].join(''),
);

process.exit(0);

function emit(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext},
    })}\n`,
  );
}

/** 用 CLI 列出文档与修订号；CLI 不可用时返回空表，不影响捕获本身。 */
async function listRevisions(root) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, root, 'ls', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.on('error', () => resolve(undefined));
    child.on('close', () => resolve(stdout));
  });

  const map = new Map();

  if (!result) {
    return map;
  }

  try {
    for (const doc of JSON.parse(result).docs ?? []) {
      map.set(doc.id, doc.revision);
    }
  } catch {
    // 解析失败就当作没有基线，最多让变更列表不完整。
  }

  return map;
}

function buildInstruction(root, prompt) {
  return [
    '你是 derivedoc 的捕获子会话。主会话刚收到下面这条用户消息，你要在它开始处理之前，',
    '把该沉淀的东西落进文档。',
    '',
    `工作区：${root}`,
    '',
    '用户消息：',
    '---',
    prompt,
    '---',
    '',
    '按顺序做这几件事：',
    '',
    `1. \`dd ${root} ls\` 看有哪些文档，用 \`dd ${root} read <id>\` 读相关的 source 与 derived。`,
    '2. 判断这条消息里有没有决定：用户明确的方向、约束、取舍。有就追加到最合适的 source',
    `   文档，用 \`dd ${root} append <id> '## 决定：……'\`（必要时先建新文档，内容保持`,
    '   高层精简）。没有决定就不要写——提问、确认、局部细节调整都不要写进 source。',
    '   只写决定本身，不要写测试记录、验证步骤、待办、计划、过程回顾这类内容。',
    '3. 默认不动 derived。只有这条消息明确改变了设计，且你能指出具体是哪一节时，才改那一',
    '   节；不要调整文档结构，不要新增「验证」「下一步」「待办」之类的小节。不确定就留着',
    '   不动。',
    `4. 如果确实改了文档，把一句话摘要覆盖写进 ${root}/.derivedoc/commit-message（例如`,
    '   「记录注入方式的选择」），供用户一键提交时使用；没改文档就不要动这个文件。',
    '5. 最后把「这条消息意味着什么」的思考过程作为最终回复输出：按时间顺序、包含中间结论',
    '   与转折原因，第一人称（你就是主会话），完整但精简，能被接下来的思考直接接上。不要',
    '   写成报告或清单。',
    '',
    '约束：不动无关文档；不重写整篇 source；不臆造用户没说的需求。',
  ].join('\n');
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}
