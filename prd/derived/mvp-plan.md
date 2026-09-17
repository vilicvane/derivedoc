# MVP 计划

**依据**：[产品定位与痛点](../source/product.md) · [两层文档的边界](../source/two-layers.md) · [人与 agent 的接口](../source/interfaces.md)

## 范围

做：

1. `dd [<项目根>] [--doc-dir=<文档目录>]`：初始化工作区、启动本地服务（web + MCP）、打印接入方式。
2. 文档存储：markdown、时间戳与内容哈希、文件监听、乐观并发写。
3. CLI：`ls`、`read`、`stat`、`write`、`append`、`rm`，带 `--json`。
4. agent 接口：CLI 为主，MCP 作为可选常驻通道。
5. web：浏览两层文档、渲染、直接编辑、启动空白会话、会话链接列表、对会话发起通知、
   看到变更 diff。
6. 通知与同步：source 变更后向工作中的会话发行级 diff；空闲会话在下次用户消息时合并。
7. 派生队列：串行执行，用户任务优先。
8. harness 适配：先做 Codex——第一步拦住用户消息、跑子会话沉淀 source；下一步再接
   app-server 客户端，把思考注入主会话。

不做（后置）：web 内对话、精确覆盖追踪、内置 LLM 调用、账号与远程协作、全文与向量检索、
自建版本历史。

## 里程碑

| 阶段 | 内容 | 完成标志 | 状态 |
| --- | --- | --- | --- |
| M1 | core store + CLI + 服务骨架 | `dd` 起服务；CLI 与 MCP 能读写文档 | 已完成 |
| M2 | web 可用：浏览、渲染、编辑、变更可见 | 浏览器里能改 source 并看到结果 | 已完成（Monaco 编辑与 diff、git 提交）；会话列表与通知入口未做 |
| M3 | 会话注册、diff 通知、派生队列 | 改 source 后工作中的会话收到 diff；派生串行且用户优先 | 未开始 |
| M4a | Codex 捕获：拦用户消息、跑子会话沉淀 source | 一条含决定的用户消息能自动落进 source | 已完成，prompt 仍在收紧 |
| M4b | Codex 注入：把捕获后的思考交回主会话 | 一条用户消息走完「source 沉淀 → 思考注入」 | 未开始 |
| M5 | dogfood 与 alpha：用 derivedoc 维护本目录，`npx` 可用 | 在真实项目里跑起来 | dogfood 已开始 |

## 技术栈

Node.js ≥ 24（原生执行 TS）、TypeScript strict、Hono（HTTP）、ws（变更推送）、
`@modelcontextprotocol/sdk`、yaml（frontmatter）、chokidar（文件监听）、zod（校验）、
Vite + React（界面）、esbuild（打包 CLI）、`node:test`（测试）。

## 包结构

单包，按目录分模块：

```text
src/core/     frontmatter、修订号、文档索引、文件监听、项目初始化
src/server/   HTTP API + WebSocket + MCP
src/cli/      参数解析、子命令、服务启动
src/web/      Vite + React 界面
```

理由：MVP 优先跑通闭环，模块边界在目录层面已经清晰；等确实要发布多个产物（比如把
harness 适配单独发）再拆包，代价很小。影响是只有一份 tsconfig 与构建配置，web 由 Vite
单独构建、产物交给 server 托管。
