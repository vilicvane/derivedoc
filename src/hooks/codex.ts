import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {appendConversation} from '../core/conversations.ts';
import {describeWorkspace, findProjectRoot} from '../core/project.ts';
import {listWorkspaces} from '../core/registry.ts';
import {DocStore} from '../core/store.ts';

export const PROJECT_INSTRUCTIONS_FILE = 'DERIVEDOC.md';
export const CODEX_HOOK_COMMAND = 'derivedoc hook codex-prompt-submit';

export const DEFAULT_PROJECT_INSTRUCTIONS = `# derivedoc 项目规则

## source 只记已确认的决定

只把用户已经确认的方向、约束、取舍和需求写入 source。考虑、比较、假设、提问、
分析请求与 agent 自己的建议不是决定。拿不准时不写。

## TODO 跟随已确认要求的生命周期

只有用户已确认、要求产生可观察的项目状态变化，并且检查后确认尚未完成时，才写
单独一行的 \`TODO: …\`。候选方案、分析请求和 agent 自己提出的后续工作不得生成 TODO。

执行相关工作的 agent 负责主动维护待办状态。在结束任务前检查相关 source 与 derived：
已完成就删除 TODO 并同步实现状态；部分完成就把 TODO 改成剩余缺口。只有能从代码、配置或
运行结果确认完成时才能清除。
`;

interface HookPayload {
  cwd?: unknown;
  prompt?: unknown;
  session_id?: unknown;
  turn_id?: unknown;
}

interface HookGroup {
  hooks?: Array<{type?: unknown; command?: unknown; [key: string]: unknown}>;
  [key: string]: unknown;
}

interface HooksFile {
  description?: unknown;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexInstallResult {
  created: string[];
  updated: string[];
}

export interface RunCodexHookOptions {
  /** 开发脚本已经定位到的工作区；安装后的 CLI 通常留空，从 payload.cwd 向上找。 */
  workspaceRoot?: string;
  /** 供捕获子会话调用的当前 derivedoc CLI 入口。 */
  cliEntry: string;
  input?: string;
}

/**
 * 给项目安装 Codex 适配。项目规则只创建一次，之后完全由项目维护；
 * hooks.json 只合并 derivedoc 自己的条目，不覆盖已有钩子。
 */
export async function installCodexIntegration(root: string): Promise<CodexInstallResult> {
  const projectRoot = path.resolve(root);
  const codexDir = path.join(projectRoot, '.codex');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const instructionsPath = path.join(projectRoot, PROJECT_INSTRUCTIONS_FILE);
  const created: string[] = [];
  const updated: string[] = [];

  if (!(await exists(codexDir))) {
    await fs.mkdir(codexDir, {recursive: true});
    created.push('.codex/');
  }

  try {
    await fs.writeFile(instructionsPath, DEFAULT_PROJECT_INSTRUCTIONS, {flag: 'wx'});
    created.push(PROJECT_INSTRUCTIONS_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  const current = await readHooksFile(hooksPath);
  const events = ensureEvents(current);
  const groups = ensureHookGroups(events, 'UserPromptSubmit');

  if (!hasDerivedocHook(groups)) {
    groups.push({
      hooks: [
        {
          type: 'command',
          command: CODEX_HOOK_COMMAND,
          timeout: 600,
          statusMessage: 'derivedoc 正在沉淀这条消息…',
        },
      ],
    });

    const wasPresent = await exists(hooksPath);
    await fs.writeFile(hooksPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    (wasPresent ? updated : created).push('.codex/hooks.json');
  }

  return {created, updated};
}

/** Codex UserPromptSubmit 命令钩子的完整执行入口。 */
export async function runCodexPromptSubmit(options: RunCodexHookOptions): Promise<void> {
  // 捕获子会话会继承这个变量，它自己不再触发捕获。
  if (process.env['DERIVEDOC_CAPTURE']) {
    return;
  }

  const raw = options.input ?? (await readStdin());
  let payload: HookPayload;

  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return;
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';

  if (!prompt.trim() || !sessionId) {
    return;
  }

  const workspaceRoot =
    (options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined) ??
    (await resolveWorkspace(payload.cwd));

  if (!workspaceRoot) {
    return;
  }

  const projectInstructions = await readProjectInstructions(workspaceRoot);

  if (process.env['DERIVEDOC_HOOK_PROBE']) {
    emit(addProjectInstructions(`PROBE-MARKER-${Date.now()}`, projectInstructions));
    return;
  }

  const pendingDir = path.join(workspaceRoot, '.derivedoc', 'pending');
  await fs.mkdir(pendingDir, {recursive: true});

  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
  await appendConversation(workspaceRoot, sessionId, {
    type: 'message',
    at: new Date().toISOString(),
    sessionId,
    ...(turnId ? {turnId} : {}),
    channel: 'codex',
    text: prompt,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(pendingDir, `${stamp}-${turnId ?? 'turn'}.md`);
  const logFile = path.join(workspaceRoot, '.derivedoc', 'capture.log');
  const before = await listRevisions(workspaceRoot);
  const startedAt = Date.now();
  const code = await runCaptureChild({
    workspaceRoot,
    sessionId,
    outFile,
    instruction: buildCaptureInstruction(
      workspaceRoot,
      prompt,
      projectInstructions,
      options.cliEntry,
    ),
  });

  const elapsedMs = Date.now() - startedAt;
  const after = await listRevisions(workspaceRoot);
  let thinking = '';

  try {
    thinking = (await fs.readFile(outFile, 'utf8')).trim();
  } catch {
    // 子会话没写出结果，保持为空。
  }

  const succeeded = code.code === 0 && Boolean(thinking);
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
    thinking = thinking.slice(0, touchedMatch.index).trimEnd();
    await fs.writeFile(outFile, `${thinking}\n`, 'utf8');
  }

  await fs.appendFile(
    logFile,
    `${JSON.stringify({
      at: new Date().toISOString(),
      elapsedMs,
      code: code.code,
      sessionId,
      prompt: prompt.slice(0, 200),
      thinkingChars: thinking.length,
      before: before.size,
      after: after.size,
      changed,
      stderr: code.code === 0 ? undefined : code.stderr.slice(-500),
    })}\n`,
  );

  if (!succeeded) {
    await fs.rm(outFile, {force: true});
    emit(
      addProjectInstructions(
        `derivedoc：这条消息的捕获没有产出（退出码 ${String(code.code)}）。详情见 ${path.relative(workspaceRoot, logFile)}。`,
        projectInstructions,
      ),
    );
    await appendConversation(workspaceRoot, sessionId, {
      type: 'capture',
      at: new Date().toISOString(),
      sessionId,
      ...(turnId ? {turnId} : {}),
      changed: [],
      elapsedMs,
      code: code.code,
    });
    return;
  }

  emit(
    addProjectInstructions(
      [
        'derivedoc：这条用户消息已经过一轮捕获。',
        `推理过程在 ${path.relative(workspaceRoot, outFile)}（完整但精简，需要时自己读它）。`,
        changed.length > 0
          ? `本轮更新的文档：${changed.join('、')}。`
          : '本轮没有文档变更（这条消息没有产生需要沉淀的决定）。',
      ].join(''),
      projectInstructions,
    ),
  );

  await appendConversation(workspaceRoot, sessionId, {
    type: 'capture',
    at: new Date().toISOString(),
    sessionId,
    ...(turnId ? {turnId} : {}),
    changed,
    thinking: path.relative(workspaceRoot, outFile),
    elapsedMs,
    code: code.code,
  });
}

export function buildCaptureInstruction(
  root: string,
  prompt: string,
  projectInstructions: string,
  cliEntry: string,
): string {
  const cli = `${shellArg(process.execPath)} ${shellArg(path.resolve(cliEntry))}`;

  return [
    '你是 derivedoc 的捕获子会话。主会话刚收到下面这条用户消息。你先判断它是否',
    '包含已经确认、需要长期保留的决定；没有就不要改文档。完全不写是正常结果，',
    '而且优先于误写。不要因为候选方案描述得具体，就推断用户已经采用它。',
    '',
    `工作区：${root}`,
    '',
    '用户消息：',
    '---',
    prompt,
    '---',
    '',
    `项目规则（来自 ${PROJECT_INSTRUCTIONS_FILE}）：`,
    '---',
    projectInstructions.trim(),
    '---',
    '',
    '按顺序做这几件事：',
    '',
    '1. 在任何写入前，对消息里的每个候选命题判定承诺状态：',
    '   - 已确认：用户明确要求实施、规定最终行为，或明确采用此前方案。',
    '   - 探索中：用户正在考虑、比较、假设或询问某个方案。',
    '   - 请求分析：用户要求解释、评估、诊断或提供建议。',
    '   - 陈述事实：用户只在描述现状、观察或问题。',
    '   只有“已确认”能继续到写入步骤；其它类型不写 source，也不生成 TODO。',
    '   “我在考虑……”“要不要……”“也许……”“可以……”“是否更好”“应该怎么做”',
    '   都表示尚未承诺。“你说得对”默认只确认前文的判断或事实；只有“就按这个方案做”',
    '   “请照此修改”等明确表达才算采用方案。',
    '   反例：“我在考虑要不要把待办提示词放进项目文档，可以提供一个模板”不写。',
    '   正例：“就按这个方案，把待办提示词移到项目模板”才写。',
    `2. 如果有“已确认”的内容，用 \`${cli} ${shellArg(root)} ls\` 看有哪些文档，用`,
    `   \`${cli} ${shellArg(root)} read <id>\` 读相关的 source 与 derived。没有就跳过所有文档写入。`,
    '3. source 读起来要像精简的产品内部手册：一件事一个 `##` 小节，直接写规则，讲清是什么、',
    '   为什么、边界在哪。不要给每条加“决定：”前缀，也不要写会议纪要式的流水。',
    `   用 \`${cli} ${shellArg(root)} append <id> '## 小节名\\n\\n规则…'\` 写进最合适的 source 文档`,
    '   （必要时先建新文档）；优先补进已有的相关小节，没有合适的再新开。',
    '   一条消息里可能同时有多个命题：只分别写入其中“已确认”的部分，不得让未确认部分',
    '   产生文档或 TODO。不写闲聊、局部细节、以及你自己拿的主意；拿不准就不写。',
    '   只写规则本身：不要写测试记录、验证步骤、计划、过程回顾。尽量保留用户的措辞，便于溯源。',
    '4. TODO 只能在三个条件同时成立时生成：对应要求已被用户明确确认；用户要求产生',
    '   可观察的项目状态变化；检查代码、配置或文档后能确认它尚未完成。候选方案、分析请求、',
    '   agent 自己建议的后续工作，以及仅仅“被提到但尚未做”的事都不得生成 TODO。',
    '   已确认但尚未完成的要求才单独一行标 `TODO: …`；已经做完的不要标。',
    '5. 默认不动 derived。只有这条消息明确改变了设计，且你能指出具体是哪一节时，才改那一',
    '   节；不要调整文档结构，也不要新增“验证”“下一步”这类小节。不确定就留着不动。',
    `6. 如果确实改了文档，把一句话摘要覆盖写进 ${root}/.derivedoc/commit-message；没改就不要动。`,
    '7. 最后把“这条消息意味着什么”的思考摘要作为最终回复输出：按时间顺序、包含中间结论',
    '   与转折原因，第一人称，完整但精简，能被接下来的思考直接接上。不要写成报告或清单。',
    '8. 思考摘要的最后另起一行写 `TOUCHED: <逗号分隔的文档 id>`；一篇都没改就写 `TOUCHED:`。',
    '',
    '约束：不动无关文档；不重写整篇 source；不臆造用户没说的需求。',
  ].join('\n');
}

async function runCaptureChild(options: {
  workspaceRoot: string;
  sessionId: string;
  outFile: string;
  instruction: string;
}): Promise<{code: number; stderr: string}> {
  const timeoutMs = Number(process.env['DERIVEDOC_CAPTURE_TIMEOUT'] ?? 180_000);
  const child = spawn(
    'codex',
    [
      'exec',
      'fork',
      options.sessionId,
      '--ephemeral',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      `sandbox_workspace_write.writable_roots=${JSON.stringify([options.workspaceRoot])}`,
      '-c',
      'approval_policy="never"',
      '-o',
      options.outFile,
      options.instruction,
    ],
    {
      cwd: options.workspaceRoot,
      env: {...process.env, DERIVEDOC_CAPTURE: '1'},
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => (stderr += chunk));

  let forceTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  }, timeoutMs);

  const code = await new Promise<number>(resolve => {
    child.on('error', error => {
      stderr += `\n${error.message}`;
      resolve(1);
    });
    child.on('close', value => resolve(value ?? 1));
  });

  clearTimeout(timer);
  if (forceTimer) {
    clearTimeout(forceTimer);
  }

  return {code, stderr};
}

async function listRevisions(root: string): Promise<Map<string, string>> {
  const workspace = await describeWorkspace(root);

  if (!workspace.exists) {
    return new Map();
  }

  const store = await DocStore.open(workspace.docs, {watch: false});

  try {
    return new Map(store.list().map(doc => [doc.id, doc.revision]));
  } finally {
    await store.close();
  }
}

async function resolveWorkspace(cwd: unknown): Promise<string | undefined> {
  if (typeof cwd !== 'string' || !cwd) {
    return undefined;
  }

  const target = path.resolve(cwd);
  const enclosing = await findProjectRoot(target);

  if (enclosing) {
    return enclosing;
  }

  // 在项目的直接父目录里工作时，只有唯一注册候选才自动选它。
  const entries = await listWorkspaces();
  const matches = new Set(
    entries
      .filter(entry => [entry.root, entry.docs].some(candidate => path.dirname(candidate) === target))
      .map(entry => entry.root),
  );

  return matches.size === 1 ? [...matches][0] : undefined;
}

async function readProjectInstructions(root: string): Promise<string> {
  try {
    const contents = await fs.readFile(path.join(root, PROJECT_INSTRUCTIONS_FILE), 'utf8');
    return contents.slice(0, 20_000);
  } catch {
    return DEFAULT_PROJECT_INSTRUCTIONS;
  }
}

function addProjectInstructions(message: string, instructions: string): string {
  return [
    message,
    '',
    `以下是项目维护的 ${PROJECT_INSTRUCTIONS_FILE} 规则。主 agent 本轮结束前必须按它核对文档与 TODO：`,
    '---',
    instructions.trim(),
    '---',
  ].join('\n');
}

function emit(additionalContext: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext},
    })}\n`,
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function readHooksFile(file: string): Promise<HooksFile> {
  let raw: string;

  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {description: 'Project-local hooks for derivedoc.', hooks: {}};
    }
    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} 不是有效 JSON，不会覆盖它`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${file} 的根必须是 JSON 对象，不会覆盖它`);
  }

  return parsed as HooksFile;
}

function ensureEvents(config: HooksFile): Record<string, unknown> {
  if (config.hooks === undefined) {
    config.hooks = {};
  }

  if (!isRecord(config.hooks)) {
    throw new Error('.codex/hooks.json 的 hooks 必须是 JSON 对象');
  }

  return config.hooks;
}

function ensureHookGroups(events: Record<string, unknown>, event: string): HookGroup[] {
  if (events[event] === undefined) {
    events[event] = [];
  }

  if (!Array.isArray(events[event])) {
    throw new Error(`.codex/hooks.json 的 hooks.${event} 必须是数组`);
  }

  return events[event] as HookGroup[];
}

function hasDerivedocHook(groups: HookGroup[]): boolean {
  return groups.some(group =>
    Array.isArray(group?.hooks)
      ? group.hooks.some(
          hook =>
            typeof hook?.command === 'string' &&
            (hook.command === CODEX_HOOK_COMMAND || hook.command.includes('codex-prompt-submit')),
        )
      : false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
