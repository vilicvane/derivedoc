#!/usr/bin/env node
import process from 'node:process';

import {initProject} from '../core/project.ts';
import {DocStore} from '../core/store.ts';
import {CliError, parseArgs} from './args.ts';
import {reportError, runCommand} from './commands.ts';

const DEFAULT_PORT = 7788;

const HELP = `derivedoc — source 沉淀决定，derived 承载方案

用法
  dd <目录>                              启动服务（web 界面 + MCP）
  dd <目录> root                         打印所属的 derivedoc 工作区，不在工作区则退出码 1
  dd <目录> ls [--kind source|derived]   列出文档
  dd <目录> read <id>                    打印正文（--json 输出完整结构）
  dd <目录> stat <id>                    只打印当前修订号
  dd <目录> write <id>                   整篇写入，内容从 stdin 或 --content 读
  dd <目录> append <id>                  追加到文末，内容从 stdin 或 --content 读
  dd <目录> rm <id>                      删除文档

选项
  -p, --port <端口>        监听端口，默认 ${DEFAULT_PORT}（被占用时自动顺延）
      --host <地址>        监听地址，默认 127.0.0.1
      --open               启动后打开浏览器
      --json               结构化输出，便于脚本与 agent 解析
      --base-revision <r>  写入前的并发校验，不匹配则报 conflict
  -h, --help               显示帮助
  -v, --version            显示版本

示例
  dd ./prd read source/requirements | head -20
  dd ./prd append source/requirements --content '## 决定：先手动用起来'
  rev=$(dd ./prd stat derived/storage)
  dd ./prd write derived/storage --base-revision "$rev" < storage.md
`;

async function main(): Promise<void> {
  const {positionals, options} = parseArgs(process.argv.slice(2));
  const json = options.get('json') === true;
  const [dir, command, ...rest] = positionals;

  if (options.get('version')) {
    process.stdout.write('derivedoc 0.0.0\n');
    return;
  }

  if (options.get('help') || (!dir && !command)) {
    process.stdout.write(HELP);
    return;
  }

  try {
    if (!command) {
      await serve(dir!, options.get('port'), options.get('host'), options.get('open') === true);
      return;
    }

    await runCommand(dir!, command, rest, {
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
  dir: string,
  port: unknown,
  host: unknown,
  open: boolean,
): Promise<void> {
  const portNumber = typeof port === 'string' ? Number(port) : DEFAULT_PORT;

  if (!Number.isInteger(portNumber) || portNumber <= 0) {
    throw new CliError(`--port 需要一个端口号，收到：${String(port)}`);
  }

  const init = await initProject(dir);
  const store = await DocStore.open(dir);
  // 服务栈（Hono、MCP、ws）只在真正要起服务时加载，普通子命令不必付这份成本。
  const {startServer} = await import('../server/index.ts');
  const server = await startServer(store, {
    port: portNumber,
    ...(typeof host === 'string' ? {host} : {}),
  });

  const counts = countByKind(store);

  process.stdout.write(
    [
      `derivedoc  ${server.url}`,
      `  项目目录  ${store.root}${init.created.length ? `（新建 ${init.created.join('、')}）` : ''}`,
      `  文档      source ${counts.source} · derived ${counts.derived}`,
      `  MCP       ${server.mcpUrl}`,
      '',
      `  命令行：dd ${dir} ls`,
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

function countByKind(store: DocStore): {source: number; derived: number} {
  const docs = store.list();

  return {
    source: docs.filter(doc => doc.kind === 'source').length,
    derived: docs.filter(doc => doc.kind === 'derived').length,
  };
}

main().catch(error => {
  process.exitCode = reportError(error, false);
});
