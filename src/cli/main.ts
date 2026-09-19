#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  createWorkspace,
  DEFAULT_DOCS_DIR,
  describeWorkspace,
  initProject,
  writeDocsDir,
  type InitResult,
  type WorkspacePaths,
} from '../core/project.ts';
import type {WorkspaceHub} from '../server/hub.ts';
import {CliError, parseArgs} from './args.ts';
import {COMMANDS, reportError, runCommand} from './commands.ts';

const DEFAULT_PORT = 7788;

/** 从当前文件往上找带 vite.config.ts 的包根目录。 */
async function findPackageRoot(): Promise<string | undefined> {
  const fs = await import('node:fs');
  let dir = import.meta.dirname;

  for (let depth = 0; depth < 5; depth++) {
    if (fs.existsSync(path.join(dir, 'vite.config.ts'))) {
      return dir;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  return undefined;
}

const HELP = `derivedoc — source 沉淀决定，derived 承载方案

用法
  dd [<项目根>=.] [--doc-dir=<文档目录>] [子命令]

  不给子命令就启动服务（web 界面 + MCP）。

子命令
  dd [<项目根>] init [--doc-dir=<文档目录>]  初始化文档、项目规则与 Codex 钩子
  dd [<项目根>] root [--json]                打印项目根与文档目录；不在工作区则退出码 1
  dd [<项目根>] ls [--kind source|derived]   列出文档
  dd [<项目根>] read <id>                    打印正文（--json 输出完整结构）
  dd [<项目根>] stat <id>                    只打印当前修订号
  dd [<项目根>] write <id>                   整篇写入，内容从 stdin 或 --content 读
  dd [<项目根>] append <id>                  追加到文末，内容从 stdin 或 --content 读
  dd [<项目根>] rm <id>                      删除文档
  dd [<项目根>] selection                    打印界面上选中的那段（agent 拿它当上下文）

工作区
  项目根放 .derivedoc/（运行数据，也是 git 作用域），文档目录放 source/ 与 derived/。
  项目根默认当前目录，文档目录默认 ${DEFAULT_DOCS_DIR}/；指定的文档目录记进
  .derivedoc/config.json，之后的调用可以省略。

选项
      --doc-dir <目录>     文档目录，相对项目根；省略时用项目里记下的，没记过就用 ${DEFAULT_DOCS_DIR}/
  -p, --port <端口>        监听端口，默认 ${DEFAULT_PORT}（被占用时自动顺延）
      --host <地址>        监听地址，默认 127.0.0.1
      --open               启动后打开浏览器
      --json               结构化输出，便于脚本与 agent 解析
      --base-revision <r>  写入前的并发校验，不匹配则报 conflict
      --dev                watch 构建前端，改完自动刷新页面
  -h, --help               显示帮助
  -v, --version            显示版本

示例
  derivedoc init                        # 完整初始化当前项目（含 Codex 项目钩子）
  derivedoc init --doc-dir=prd          # 文档放 prd/，项目钩子仍放根目录
  dd                                     # 建工作区：项目根是当前目录，文档在 ddoc/
  dd . --doc-dir=prd                     # 文档改放 prd/
  dd ./app --doc-dir=.                   # 项目根与文档目录都是 ./app
  dd ls                                  # 之后在项目里不带目录也能用
  dd read source/requirements | head -20
  rev=$(dd stat derived/storage)
  dd write derived/storage --base-revision "$rev" < storage.md
`;

async function main(): Promise<void> {
  const {positionals, options} = parseArgs(process.argv.slice(2));
  const json = options.get('json') === true;
  // 第一位是项目根；如果它本身是个子命令，就按「在 cwd 里跑子命令」理解。
  const [first, ...tail] = positionals;
  const inline = first !== undefined && COMMANDS.has(first);
  const projectDir = inline ? '.' : (first ?? '.');
  const command = inline ? first : tail[0];
  const rest = inline ? tail : tail.slice(1);
  const docDir = typeof options.get('doc-dir') === 'string' ? (options.get('doc-dir') as string) : undefined;

  if (options.get('version')) {
    process.stdout.write('derivedoc 0.0.0\n');
    return;
  }

  if (options.get('help')) {
    process.stdout.write(HELP);
    return;
  }

  try {
    if (!command) {
      await serve(
        projectDir,
        docDir,
        options.get('port'),
        options.get('host'),
        options.get('open') === true,
        options.get('dev') === true,
      );
      return;
    }

    await runCommand(projectDir, docDir, command, rest, {
      json,
      ...(typeof options.get('kind') === 'string' ? {kind: options.get('kind') as string} : {}),
      ...(typeof options.get('base-revision') === 'string'
        ? {baseRevision: options.get('base-revision') as string}
        : {}),
      ...(typeof options.get('content') === 'string'
        ? {content: options.get('content') as string}
        : {}),
    });
  } catch (error) {
    process.exitCode = reportError(error, json);
  }
}

// 管道提前关闭（比如 `dd prd ls | head`）不算错误。
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    process.exit(0);
  }

  throw error;
});

async function serve(
  projectDir: string,
  docDir: string | undefined,
  port: unknown,
  host: unknown,
  open: boolean,
  dev: boolean,
): Promise<void> {
  const portNumber = typeof port === 'string' ? Number(port) : DEFAULT_PORT;

  if (!Number.isInteger(portNumber) || portNumber <= 0) {
    throw new CliError(`--port 需要一个端口号，收到：${String(port)}`);
  }

  const cwd = process.cwd();
  const resolved = await describeWorkspace(projectDir, docDir, {cwd});
  let paths: WorkspacePaths;
  let init: InitResult;

  if (resolved.exists) {
    // 显式给了文档目录就以它为准，并记进项目配置，之后不带 --doc-dir 也认得。
    if (docDir) {
      await writeDocsDir(resolved.root, resolved.docs);
    }

    paths = {root: resolved.root, docs: resolved.docs};
    init = await initProject(paths.root, paths.docs);
  } else {
    const created = await createWorkspace(projectDir, docDir ?? DEFAULT_DOCS_DIR, {cwd});
    paths = {root: created.root, docs: created.docs};
    init = created.init;
  }

  // 服务栈（Hono、MCP、ws）只在真正要起服务时加载，普通子命令不必付这份成本。
  const [{startServer}, {WorkspaceHub}] = await Promise.all([
    import('../server/index.ts'),
    import('../server/hub.ts'),
  ]);
  const hub = await WorkspaceHub.open(paths);
  const packageRoot = await findPackageRoot();

  if (dev && !packageRoot) {
    throw new CliError('找不到 vite.config.ts，--dev 需要在源码仓库里运行');
  }

  const server = await startServer(hub, {
    port: portNumber,
    ...(typeof host === 'string' ? {host} : {}),
    ...(packageRoot ? {dev: {configFile: path.join(packageRoot, 'vite.config.ts')}} : {}),
  });

  const counts = await countByKind(hub);
  const portNote =
    server.port === portNumber ? '' : `（${portNumber} 被占用，顺延到 ${server.port}）`;
  const staleWeb = dev ? undefined : await webBuildHint(packageRoot);
  const projectArg = path.relative(cwd, paths.root) || '.';
  const docsRel = path.relative(paths.root, paths.docs) || '.';
  const docsLabel =
    docsRel === '.'
      ? '.（就是项目根）'
      : docsRel.startsWith('..')
        ? paths.docs
        : `${docsRel}/`;

  process.stdout.write(
    [
      `derivedoc  ${server.url}${portNote}`,
      `  项目根    ${paths.root}${init.created.length ? `（新建 ${init.created.join('、')}）` : ''}`,
      `  文档目录  ${docsLabel}`,
      `  文档      source ${counts.source} · derived ${counts.derived}`,
      `  MCP       ${server.mcpUrl}`,
      ...(dev ? ['  模式      dev（Vite watch 构建，改完自动刷新页面）'] : []),
      ...(staleWeb ? [`  提示      ${staleWeb}`] : []),
      '',
      `  命令行：dd ${projectArg} ls`,
      `  接入 Codex：codex mcp add derivedoc --url ${server.mcpUrl}`,
      '',
      '  按 Ctrl+C 停止',
      '',
    ].join('\n'),
  );

  if (open) {
    const {spawn} = await import('node:child_process');
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', server.url] : [server.url];

    try {
      spawn(command, args, {detached: true, stdio: 'ignore'}).unref();
    } catch {
      // 打不开就算了，地址已经打印出来了。
    }
  }

  const shutdown = async () => {
    process.stdout.write('\n正在停止…\n');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** 生产模式下提醒产物比源码旧：否则改完界面会以为没生效。 */
async function webBuildHint(packageRoot: string | undefined): Promise<string | undefined> {
  if (!packageRoot) {
    return undefined;
  }

  const newest = async (dir: string): Promise<number> => {
    let latest = 0;

    const walk = async (current: string): Promise<void> => {
      let entries;

      try {
        entries = await fs.readdir(current, {withFileTypes: true});
      } catch {
        return;
      }

      for (const entry of entries) {
        const child = path.join(current, entry.name);

        if (entry.isDirectory()) {
          await walk(child);
          continue;
        }

        const stat = await fs.stat(child).catch(() => undefined);

        if (stat) {
          latest = Math.max(latest, stat.mtimeMs);
        }
      }
    };

    await walk(dir);
    return latest;
  };

  const [source, build] = await Promise.all([
    newest(path.join(packageRoot, 'src/web')),
    newest(path.join(packageRoot, 'bld/web')),
  ]);

  if (source > build) {
    return '界面产物比源码旧，跑 npm run web:build，或者用 --dev 自动重建并刷新页面';
  }

  return undefined;
}

async function countByKind(hub: WorkspaceHub): Promise<{source: number; derived: number}> {
  const view = await hub.get(hub.defaultId);
  const docs = view?.store.list() ?? [];

  return {
    source: docs.filter(doc => doc.kind === 'source').length,
    derived: docs.filter(doc => doc.kind === 'derived').length,
  };
}

main().catch(error => {
  process.exitCode = reportError(error, false);
});
