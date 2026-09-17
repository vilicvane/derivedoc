import {createServer, type Server} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';

import {getRequestListener} from '@hono/node-server';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {WebSocketServer} from 'ws';

import type {DocStore} from '../core/store.ts';
import {createApp} from './app.ts';
import type {WorkspaceHub} from './hub.ts';
import {createMcpServer} from './mcp.ts';

export interface ServerOptions {
  port: number;
  host?: string;
  /** 开发模式：跑 Vite 的 watch 构建，构建完成后让页面自己刷新。 */
  dev?: {configFile: string};
}

export interface RunningServer {
  port: number;
  host: string;
  url: string;
  mcpUrl: string;
  close(): Promise<void>;
}

export async function startServer(
  hub: WorkspaceHub,
  options: ServerOptions,
): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const app = createApp(hub);
  const honoListener = getRequestListener(app.fetch);
  let devWatcher: {close(): Promise<void>} | undefined;

  // stateless 模式的约定：每个请求一套 server + transport，用完即弃。
  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405, {'content-type': 'application/json'}).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {code: -32000, message: 'Method not allowed.'},
          id: null,
        }),
      );
      return;
    }

    const wsId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ws') ?? hub.defaultId;
    const view = await hub.get(wsId);

    if (!view) {
      res.writeHead(404, {'content-type': 'application/json'}).end(
        JSON.stringify({jsonrpc: '2.0', error: {code: -32602, message: `没有这个工作区：${wsId}`}, id: null}),
      );
      return;
    }

    const server = createMcpServer(view.store);
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const server = createServer((req, res) => {
    const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '/';

    if (pathname === '/mcp') {
      void handleMcp(req, res).catch(error => {
        process.stderr.write(
          `[mcp] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );

        if (!res.headersSent) {
          res.writeHead(500, {'content-type': 'application/json'});
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {code: -32603, message: 'Internal server error'},
              id: null,
            }),
          );
          return;
        }

        res.end();
      });
      return;
    }

    void honoListener(req, res);
  });

  const wss = new WebSocketServer({server, path: '/ws'});
  const clients = new Set<import('ws').WebSocket>();

  // 端口被占用时 http server 会重试下一个端口，wss 会把同一个错误再抛一次；
  // 不接住它进程就直接崩了，顺延也就无从谈起。
  wss.on('error', error => {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      process.stderr.write(`[ws] ${error.message}\n`);
    }
  });

  const broadcast = (payload: unknown) => {
    const message = JSON.stringify(payload);

    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  };

  wss.on('connection', socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.send(JSON.stringify({type: 'ready', defaultId: hub.defaultId}));
  });

  const unsubscribe = hub.onChange(change => {
    broadcast(change);
  });

  if (options.dev) {
    const {build} = await import('vite');
    const watcher = (await build({
      configFile: options.dev.configFile,
      build: {watch: {}},
      logLevel: 'warn',
    })) as unknown as {
      on(event: string, listener: (event: {code?: string}) => void): void;
      close(): Promise<void>;
    };

    watcher.on('event', event => {
      if (event.code === 'BUNDLE_END' || event.code === 'END') {
        broadcast({type: 'reload'});
      }
    });

    devWatcher = watcher;
  }

  const port = await listen(server, options.port, host);

  return {
    port,
    host,
    url: `http://${host}:${port}`,
    mcpUrl: `http://${host}:${port}/mcp`,
    async close() {
      unsubscribe();
      for (const client of clients) {
        client.close();
      }
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await devWatcher?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await hub.close();
    },
  };
}

async function listen(server: Server, port: number, host: string): Promise<number> {
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = port + attempt;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, host);
      });

      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === maxAttempts - 1) {
        throw error;
      }
    }
  }

  throw new Error('无法找到可用端口');
}
