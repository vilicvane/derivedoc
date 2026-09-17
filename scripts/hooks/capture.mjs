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

if (!prompt.trim() || !sessionId) {
  process.exit(0);
}

// 钩子的 shell 只在「cwd 位于工作区内」时直接给路径；其余情况（比如在仓库根里工作，
// 工作区是它下面的 prd/）由这里查注册表，挑最近打开、且位于当前目录之下的那个。
const workspaceRoot = root || (await resolveWorkspaceFromRegistry(payload.cwd));

if (!workspaceRoot) {
  process.exit(0);
}

// 只验证钩子的输出通道时用：跳过子会话，直接回一段可辨认的上下文。
if (process.env.DERIVEDOC_HOOK_PROBE) {
  emit(`PROBE-MARKER-${Date.now()}`);
  process.exit(0);
}

const pendingDir = path.join(workspaceRoot, '.derivedoc', 'pending');
await fs.mkdir(pendingDir, {recursive: true});

const {appendConversation} = await import(
  new URL('../../src/core/conversations.ts', import.meta.url)
);
const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;

// 先落用户原话：即便后面的捕获失败，这句话也不会丢。
await appendConversation(workspaceRoot, sessionId, {
  type: 'message',
  at: new Date().toISOString(),
  sessionId,
  ...(turnId ? {turnId} : {}),
  channel: 'codex',
  text: prompt,
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(pendingDir, `${stamp}-${payload.turn_id ?? 'turn'}.md`);
const logFile = path.join(workspaceRoot, '.derivedoc', 'capture.log');

const before = await listRevisions(workspaceRoot);
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
    `sandbox_workspace_write.writable_roots=["${workspaceRoot}"]`,
    '-c',
    'approval_policy="never"',
    '-o',
    outFile,
    buildInstruction(workspaceRoot, prompt),
  ],
  {cwd: workspaceRoot, env: {...process.env, DERIVEDOC_CAPTURE: '1'}, stdio: ['ignore', 'pipe', 'pipe']},
);

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => (stderr += chunk));

const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
const code = await new Promise(resolve => child.on('close', resolve));
clearTimeout(timer);

const elapsed = Date.now() - startedAt;
const after = await listRevisions(workspaceRoot);
let thinking = '';

try {
  thinking = (await fs.readFile(outFile, 'utf8')).trim();
} catch {
  // 子会话没写出结果，保持为空。
}

const succeeded = code === 0 && Boolean(thinking);

// 变更优先以子会话自报的 TOUCHED 为准，再用捕获前后的修订号兜底（取并集）：
// 修订号快照在这条链路上不够可靠，实测有时看不到子会话刚写下的改动。
const touchedMatch = /\n?TOUCHED:\s*(.*)\s*$/m.exec(thinking);
const reported = (touchedMatch?.[1] ?? '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);
const byRevision = [...after]
  .filter(([id, revision]) => before.get(id) !== revision)
  .map(([id]) => id);
const changed = succeeded ? [...new Set([...reported, ...byRevision])] : [];

if (touchedMatch) {
  // 这行是给机器读的，不留在思考正文里。
  thinking = thinking.slice(0, touchedMatch.index).trimEnd();
  await fs.writeFile(outFile, `${thinking}\n`, 'utf8');
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
    before: before.size,
    after: after.size,
    changed,
    stderr: code === 0 ? undefined : stderr.slice(-500),
  })}\n`,
);

if (!succeeded) {
  await fs.rm(outFile, {force: true});
  emit(
    `derivedoc：这条消息的捕获没有产出（退出码 ${code}）。详情见 ${path.relative(workspaceRoot, logFile)}。`,
  );
  await appendConversation(workspaceRoot, sessionId, {
    type: 'capture',
    at: new Date().toISOString(),
    sessionId,
    ...(turnId ? {turnId} : {}),
    changed: [],
    elapsedMs: elapsed,
    code,
  });
  process.exit(0);
}

emit(
  [
    'derivedoc：这条用户消息已经过一轮捕获。',
    `推理过程在 ${path.relative(workspaceRoot, outFile)}（完整但精简，需要时自己读它）。`,
    changed.length > 0
      ? `本轮更新的文档：${changed.join('、')}。`
      : '本轮没有文档变更（这条消息没有产生需要沉淀的决定）。',
  ].join(''),
);

await appendConversation(workspaceRoot, sessionId, {
  type: 'capture',
  at: new Date().toISOString(),
  sessionId,
  ...(turnId ? {turnId} : {}),
  changed,
  thinking: path.relative(workspaceRoot, outFile),
  elapsedMs: elapsed,
  code,
});

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
    '2. source 读起来要像精简的产品内部手册：一件事一个 `##` 小节，直接写规则，讲清是什么、',
    '   为什么、边界在哪。**不要给每条加「决定：」前缀**，也不要写会议纪要式的流水。',
    `   用 \`dd ${root} append <id> '## 小节名\\n\\n规则…'\` 写进最合适的 source 文档`,
    '   （必要时先建新文档）；优先补进已有的相关小节，没有合适的再新开。',
    '   一条消息里可能同时提出好几件事——有几件事就写几处，不要合并成一句笼统的「用户提了',
    '   几个需求」，也不要因为其中一部分不算决定就整条跳过。',
    '3. 只有表达方向、约束、取舍、需求的话才写（「我希望…」「必须有…」「不要…」「改成…」）。',
    '   以下都不写：提问、确认、闲聊、局部细节调整、以及你自己拿的主意——实现细节、命名、',
    '   代码怎么写都不算。拿不准就不写，宁缺毋滥。',
    '   只写规则本身：不要写测试记录、验证步骤、计划、过程回顾。尽量保留用户的措辞，便于溯源。',
    '   这条消息里提到、但还没做的事，单独一行标 `TODO: …`；已经做完的不要标。',
    '4. 默认不动 derived。只有这条消息明确改变了设计，且你能指出具体是哪一节时，才改那一',
    '   节；不要调整文档结构，也不要新增「验证」「下一步」这类小节（没做完的事按上面写',
    '   TODO 行，而不是开一节）。不确定就留着不动。',
    `5. 如果确实改了文档，把一句话摘要覆盖写进 ${root}/.derivedoc/commit-message（例如`,
    '   「记录注入方式的选择」），供用户一键提交时使用；没改文档就不要动这个文件。',
    '6. 最后把「这条消息意味着什么」的思考过程作为最终回复输出：按时间顺序、包含中间结论',
    '   与转折原因，第一人称（你就是主会话），完整但精简，能被接下来的思考直接接上。不要',
    '   写成报告或清单。',
    '7. 思考的最后另起一行写 `TOUCHED: <逗号分隔的文档 id>`，报告你这一轮改了哪些 source /',
    '   derived 文档；一篇都没改就写 `TOUCHED:`。这行是机器读的，必须准确。',
    '',
    '约束：不动无关文档；不重写整篇 source；不臆造用户没说的需求；一条消息里多件事就分成',
    '多条记录。',
  ].join('\n');
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * cwd 不在任何工作区里时，看它下面有没有注册过的工作区（例如在仓库根工作、工作区是
 * 它下面的 prd/）。注册表按最近打开排序，取第一个匹配的。
 */
async function resolveWorkspaceFromRegistry(cwd) {
  if (typeof cwd !== 'string' || !cwd) {
    return undefined;
  }

  const target = path.resolve(cwd);

  let entries;

  try {
    const {listWorkspaces} = await import(new URL('../../src/core/registry.ts', import.meta.url));
    entries = await listWorkspaces();
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (entry.root === target || entry.root.startsWith(`${target}/`)) {
      return entry.root;
    }
  }

  return undefined;
}
