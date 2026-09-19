import process from 'node:process';
import path from 'node:path';

import {DocStoreError, isDocStoreError} from '../core/errors.ts';
import {
  createWorkspace,
  DEFAULT_DOCS_DIR,
  describeWorkspace,
  findProjectRoot,
  initProject,
  writeDocsDir,
  type InitResult,
  type WorkspacePaths,
} from '../core/project.ts';
import {DocStore} from '../core/store.ts';
import {installCodexIntegration, runCodexPromptSubmit} from '../hooks/codex.ts';
import {readSelection} from '../core/selection.ts';
import type {DocKind} from '../core/types.ts';
import {CliError} from './args.ts';

export interface CommandOptions {
  json: boolean;
  kind?: string;
  baseRevision?: string;
  content?: string;
}

/** 子命令名。第一位 positional 命中这些名字时按「在 cwd 里跑子命令」解释。 */
export const COMMANDS = new Set([
  'init',
  'root',
  'ls',
  'read',
  'stat',
  'write',
  'append',
  'rm',
  'selection',
  'hook',
]);

/** agent 与人都用这几个子命令读写文档，服务不必启动。 */
export async function runCommand(
  projectDir: string,
  docDir: string | undefined,
  command: string,
  rest: string[],
  options: CommandOptions,
): Promise<void> {
  switch (command) {
    case 'init':
      return initializeProject(projectDir, docDir, rest, options);
    case 'root':
      return printProjectRoot(projectDir, docDir, options);
    case 'ls':
      return listDocs(projectDir, docDir, options);
    case 'read':
      return printDocBody(projectDir, docDir, takeId(rest, 'read').id, options);
    case 'stat':
      return printDocMeta(projectDir, docDir, takeId(rest, 'stat').id, options);
    case 'write':
      return writeDoc(projectDir, docDir, takeId(rest, 'write'), options);
    case 'append':
      return appendDoc(projectDir, docDir, takeId(rest, 'append'), options);
    case 'rm':
      return removeDoc(projectDir, docDir, takeId(rest, 'rm').id, options);
    case 'selection':
      return printSelection(projectDir, docDir, options);
    case 'hook':
      return runHook(projectDir, rest);
    default:
      throw new CliError(
        `未知子命令：${command}（可用：${[...COMMANDS].join('、')}；省略子命令则启动服务）`,
      );
  }
}

/** 显式初始化完整项目：两层文档、项目规则和 Codex 项目钩子。 */
async function initializeProject(
  projectDir: string,
  docDir: string | undefined,
  rest: string[],
  options: CommandOptions,
): Promise<void> {
  if (rest.length > 0) {
    throw new CliError(`init 不接受额外参数：${rest.join(' ')}`);
  }

  const existing = await describeWorkspace(projectDir, docDir);
  let workspace: WorkspacePaths;
  let initialized: InitResult;

  if (existing.exists) {
    if (docDir) {
      await writeDocsDir(existing.root, existing.docs);
    }

    workspace = {root: existing.root, docs: existing.docs};
    initialized = await initProject(workspace.root, workspace.docs);
  } else {
    const created = await createWorkspace(projectDir, docDir ?? DEFAULT_DOCS_DIR);
    workspace = {root: created.root, docs: created.docs};
    initialized = created.init;
  }

  const codex = await installCodexIntegration(workspace.root);

  if (options.json) {
    printJson({
      root: workspace.root,
      docs: workspace.docs,
      created: [...initialized.created, ...codex.created],
      updated: codex.updated,
    });
    return;
  }

  const docs = path.relative(workspace.root, workspace.docs) || '.';
  const changes = [
    ...initialized.created.map(item => `新建 ${item}`),
    ...codex.created.map(item => `新建 ${item}`),
    ...codex.updated.map(item => `更新 ${item}`),
  ];

  process.stdout.write(
    [
      `derivedoc 已初始化 ${workspace.root}`,
      `  文档目录  ${docs === '.' ? '.' : `${docs}/`}`,
      `  Codex      .codex/hooks.json`,
      `  项目规则  ${path.join(workspace.root, 'DERIVEDOC.md')}`,
      ...(changes.length > 0 ? changes.map(item => `  ${item}`) : ['  没有需要补齐的文件']),
      '',
    ].join('\n'),
  );
}

/** 这是 hooks.json 调用的内部命令，正常不需要人手工运行。 */
async function runHook(projectDir: string, rest: string[]): Promise<void> {
  const [event, ...extra] = rest;

  if (event !== 'codex-prompt-submit' || extra.length > 0) {
    throw new CliError('hook 目前只支持 codex-prompt-submit');
  }

  await runCodexPromptSubmit({
    ...(projectDir === '.' ? {} : {workspaceRoot: path.resolve(projectDir)}),
    cliEntry: path.resolve(process.argv[1]!),
  });
}

/** 目录不构成工作区时怎么救：是上层项目的一部分，还是从头建。 */
export async function missingWorkspaceHint(projectDir: string, cwd: string): Promise<string> {
  const root = path.resolve(cwd, projectDir);
  const parent = await findProjectRoot(path.dirname(root));
  const projectArg = path.relative(cwd, root);
  const prefix = projectArg ? `dd ${projectArg}` : 'dd';

  if (parent) {
    const docs = path.relative(parent, root) || '.';

    return [
      `${root} 里没有 .derivedoc/：它属于上层项目 ${parent}。`,
      `  用那个项目：dd ${path.relative(cwd, parent) || '.'} --doc-dir=${docs}`,
    ].join('\n');
  }

  return [
    `${root} 还不是 derivedoc 工作区：${prefix} 会在这里建一个，文档目录默认 ${DEFAULT_DOCS_DIR}/。`,
    `  想放别处就带上 --doc-dir，例如 ${prefix} --doc-dir=prd；文档放项目根时用 --doc-dir=.`,
  ].join('\n');
}

/** 打开文档目录；不在工作区里就报错——子命令不会顺手建工作区。 */
async function openDocs(projectDir: string, docDir: string | undefined): Promise<DocStore> {
  const workspace = await commandWorkspace(projectDir, docDir);

  if (!workspace) {
    throw new CliError(await readOnlyHint(projectDir, docDir));
  }

  return DocStore.open(workspace.docs, {watch: false});
}

/**
 * 写入前的工作区：已有就补齐目录；没有就用给的文档目录建一个。
 */
async function prepareWorkspace(
  projectDir: string,
  docDir: string | undefined,
): Promise<WorkspacePaths> {
  const existing = await commandWorkspace(projectDir, docDir);

  if (existing) {
    await initProject(existing.root, existing.docs);
    return existing;
  }

  const created = await createWorkspace(projectDir, docDir ?? DEFAULT_DOCS_DIR);
  return {root: created.root, docs: created.docs};
}

/** 只读子命令碰不到工作区时：带 --doc-dir 说明用户是想建，只是这个子命令不建。 */
async function readOnlyHint(projectDir: string, docDir: string | undefined): Promise<string> {
  if (!docDir) {
    return missingWorkspaceHint(projectDir, process.cwd());
  }

  const cwd = process.cwd();
  const root = path.resolve(cwd, projectDir);
  const projectArg = path.relative(cwd, root);
  const prefix = projectArg ? `dd ${projectArg}` : 'dd';

  return [
    `${root} 里还没有 .derivedoc/：这个子命令只读已有工作区，不会顺手建。`,
    `  要建就跑 ${prefix} --doc-dir=${docDir}（不带子命令，会起服务）`,
  ].join('\n');
}

/** 子命令用的工作区：显式给了文档目录就记进项目配置，之后的调用不用再给。 */
async function commandWorkspace(
  projectDir: string,
  docDir: string | undefined,
): Promise<WorkspacePaths | undefined> {
  const workspace = await describeWorkspace(projectDir, docDir);

  if (workspace.exists && docDir) {
    await writeDocsDir(workspace.root, workspace.docs);
  }

  return workspace.exists ? {root: workspace.root, docs: workspace.docs} : undefined;
}

/** 判断目录属于哪个 derivedoc 工作区；不属于则退出码 1。 */
async function printProjectRoot(
  projectDir: string,
  docDir: string | undefined,
  options: CommandOptions,
): Promise<void> {
  const workspace = await commandWorkspace(projectDir, docDir);

  if (!workspace) {
    if (options.json) {
      printJson({root: null, docs: null});
    } else {
      process.stderr.write(`${await missingWorkspaceHint(projectDir, process.cwd())}\n`);
    }

    process.exitCode = 1;
    return;
  }

  if (options.json) {
    printJson({root: workspace.root, docs: workspace.docs});
    return;
  }

  process.stdout.write(`${workspace.root}\n`);
}

async function listDocs(
  projectDir: string,
  docDir: string | undefined,
  options: CommandOptions,
): Promise<void> {
  const store = await openDocs(projectDir, docDir);

  try {
    const docs = store.list(parseKind(options.kind));

    if (options.json) {
      printJson({root: store.root, docs});
      return;
    }

    for (const doc of docs) {
      process.stdout.write(
        `${doc.id}\t${doc.kind}\t${doc.revision}\t${doc.title}\t${doc.updatedAt}\n`,
      );
    }
  } finally {
    await store.close();
  }
}

async function printDocBody(
  projectDir: string,
  docDir: string | undefined,
  id: string,
  options: CommandOptions,
): Promise<void> {
  const store = await openDocs(projectDir, docDir);

  try {
    const doc = store.read(id);

    if (options.json) {
      printJson({
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
        frontmatter: doc.frontmatter,
        body: doc.body,
      });
      return;
    }

    process.stdout.write(doc.body.endsWith('\n') ? doc.body : `${doc.body}\n`);
  } finally {
    await store.close();
  }
}

async function printDocMeta(
  projectDir: string,
  docDir: string | undefined,
  id: string,
  options: CommandOptions,
): Promise<void> {
  const store = await openDocs(projectDir, docDir);

  try {
    const doc = store.read(id);

    if (options.json) {
      const {body: _body, frontmatter: _frontmatter, ...meta} = doc;
      printJson(meta);
      return;
    }

    process.stdout.write(`${doc.revision}\n`);
  } finally {
    await store.close();
  }
}

async function writeDoc(
  projectDir: string,
  docDir: string | undefined,
  target: {id: string; inline: string},
  options: CommandOptions,
): Promise<void> {
  const workspace = await prepareWorkspace(projectDir, docDir);
  const store = await DocStore.open(workspace.docs, {watch: false});

  try {
    const id = target.id;
    const content = await readContent(options, target.inline);
    const doc =
      options.baseRevision === undefined
        ? await store.write(id, content)
        : await store.write(id, content, {baseRevision: options.baseRevision});
    printWriteResult(doc, options);
  } finally {
    await store.close();
  }
}

async function appendDoc(
  projectDir: string,
  docDir: string | undefined,
  target: {id: string; inline: string},
  options: CommandOptions,
): Promise<void> {
  const workspace = await prepareWorkspace(projectDir, docDir);
  const store = await DocStore.open(workspace.docs, {watch: false});

  try {
    const id = target.id;
    const content = await readContent(options, target.inline);
    const doc = await store.append(id, content);
    printWriteResult(doc, options);
  } finally {
    await store.close();
  }
}

async function removeDoc(
  projectDir: string,
  docDir: string | undefined,
  id: string,
  options: CommandOptions,
): Promise<void> {
  const store = await openDocs(projectDir, docDir);

  try {
    await store.remove(
      id,
      options.baseRevision === undefined ? {} : {baseRevision: options.baseRevision},
    );

    if (options.json) {
      printJson({id, removed: true});
      return;
    }

    process.stdout.write(`${id} 已删除\n`);
  } finally {
    await store.close();
  }
}

/** 界面上选中的那段文字：agent 读它当上下文。 */
async function printSelection(
  projectDir: string,
  docDir: string | undefined,
  options: CommandOptions,
): Promise<void> {
  const workspace = await commandWorkspace(projectDir, docDir);

  if (!workspace) {
    throw new CliError(await readOnlyHint(projectDir, docDir));
  }

  const selection = await readSelection(workspace.root);

  if (!selection) {
    if (options.json) {
      printJson({selection: null});
    } else {
      process.stderr.write('现在没有选中内容：在界面上选一段就会记下来\n');
    }

    process.exitCode = 1;
    return;
  }

  if (options.json) {
    printJson(selection);
    return;
  }

  const lines = selection.from === selection.to ? `${selection.from}` : `${selection.from}–${selection.to}`;
  process.stdout.write(
    `${selection.doc}\t第 ${lines} 行${selection.revision ? `\trevision ${selection.revision}` : ''}\n\n${selection.quote}\n`,
  );
}

function printWriteResult(
  doc: {id: string; revision: string; updatedAt: string},
  options: CommandOptions,
): void {
  if (options.json) {
    printJson({id: doc.id, revision: doc.revision, updatedAt: doc.updatedAt});
    return;
  }

  process.stdout.write(`${doc.id}\t${doc.revision}\n`);
}

function parseKind(kind: string | undefined): {kind?: DocKind} {
  if (kind === undefined) {
    return {};
  }

  if (kind !== 'source' && kind !== 'derived') {
    throw new CliError(`--kind 只能是 source 或 derived，收到：${kind}`);
  }

  return {kind};
}

/** 取 id，并把后面多余的参数当作内联内容（用空格拼接）。 */
function takeId(rest: string[], command: string): {id: string; inline: string} {
  const [id, ...tail] = rest;

  if (!id) {
    throw new CliError(`${command} 需要文档 id，例如：dd <目录> ${command} source/requirements`);
  }

  return {id, inline: tail.join(' ')};
}

async function readContent(options: CommandOptions, inline: string): Promise<string> {
  if (options.content !== undefined) {
    return options.content;
  }

  if (inline) {
    return inline.endsWith('\n') ? inline : `${inline}\n`;
  }

  if (process.stdin.isTTY) {
    throw new CliError('需要内容：直接写在命令里、用管道传入，或者用 --content 指定');
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  const content = Buffer.concat(chunks).toString('utf8');

  if (!content.trim()) {
    throw new CliError('内容为空');
  }

  return content;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function reportError(error: unknown, json: boolean): number {
  if (isDocStoreError(error)) {
    if (json) {
      printJson({error: {code: error.code, message: error.message, ...error.detail}});
    } else {
      process.stderr.write(`error[${error.code}] ${error.message}\n`);
    }

    return 1;
  }

  if (error instanceof CliError) {
    process.stderr.write(`error ${error.message}\n`);
    return 2;
  }

  if (error instanceof DocStoreError) {
    process.stderr.write(`error ${error.message}\n`);
    return 1;
  }

  process.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}
