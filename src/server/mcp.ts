import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

import {DocStoreError} from '../core/errors.ts';
import type {DocStore} from '../core/store.ts';
import type {DocKind} from '../core/types.ts';

function json(value: unknown) {
  return {content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}]};
}

function failure(error: unknown) {
  if (error instanceof DocStoreError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({error: {code: error.code, message: error.message, ...error.detail}}),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [{type: 'text' as const, text: `写入失败：${String(error)}`}],
  };
}

export function createMcpServer(store: DocStore): McpServer {
  const server = new McpServer({name: 'derivedoc', version: '0.0.0'});

  server.registerTool(
    'list_docs',
    {
      title: '列出文档',
      description:
        '列出项目里的文档。source 是沉淀下来的决定，derived 是据此维护的设计方案。',
      inputSchema: {
        kind: z.enum(['source', 'derived']).optional().describe('只看某一层'),
      },
    },
    async ({kind}) => json(store.list(kind ? {kind: kind as DocKind} : {})),
  );

  server.registerTool(
    'read_doc',
    {
      title: '读取文档',
      description: '按 id 读取文档正文与当前修订号。',
      inputSchema: {
        id: z.string().describe('文档 id，例如 source/requirements'),
      },
    },
    async ({id}) => {
      try {
        const doc = store.read(id);
        return json({
          id: doc.id,
          kind: doc.kind,
          title: doc.title,
          revision: doc.revision,
          updatedAt: doc.updatedAt,
          links: doc.links,
          frontmatter: doc.frontmatter,
          body: doc.body,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'write_doc',
    {
      title: '写入文档',
      description:
        '整篇写入文档。带上 base_revision 做并发校验，不匹配会返回 conflict，需要重新读取后再写。',
      inputSchema: {
        id: z.string().describe('文档 id，例如 derived/storage'),
        content: z.string().describe('完整文档内容（可含 frontmatter）'),
        base_revision: z.string().optional().describe('读取时拿到的修订号'),
      },
    },
    async ({id, content, base_revision}) => {
      try {
        const doc = await store.write(
          id,
          content,
          base_revision === undefined ? {} : {baseRevision: base_revision},
        );
        return json({id: doc.id, revision: doc.revision, updatedAt: doc.updatedAt});
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'append_doc',
    {
      title: '追加内容',
      description: '在文档末尾追加内容（用空行分隔）；文档不存在时创建。适合往 source 追加一条决定。',
      inputSchema: {
        id: z.string().describe('文档 id，例如 source/requirements'),
        content: z.string().describe('要追加的内容'),
      },
    },
    async ({id, content}) => {
      try {
        const doc = await store.append(id, content);
        return json({id: doc.id, revision: doc.revision, updatedAt: doc.updatedAt});
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
