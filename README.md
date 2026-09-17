# derivedoc

把 agent 的长期记忆落在文件里的项目级文档服务：`source` 记录人的意图，`derived`
记录 agent 维护的设计；一条命令同时提供 web 界面与 MCP 接口。

设计取舍见 [prd/](prd/)：`prd/source` 是决定，`prd/derived` 是方案——本项目自己的
设计文档就用 derivedoc 维护。

## 现在能做什么

```sh
npm install
npm run dd -- ./prd        # 初始化目录、起服务，打印 web 地址与 MCP 接入方式
```

服务不是必须的。文档读写直接走 CLI 就行，只有需要界面或 MCP 时才起服务：

```sh
dd ./prd ls [--kind source|derived] [--json]   # 列出文档
dd ./prd read <id> [--json]                    # 打印正文
dd ./prd stat <id>                             # 只打印修订号
dd ./prd write <id> [--base-revision <rev>]    # 整篇写入，内容从 stdin / --content / 参数读
dd ./prd append <id> '## 决定：xxx'             # 追加到文末
dd ./prd rm <id>
```

```sh
dd ./prd append source/requirements '## 决定：先用 CLI 接入'
rev=$(dd ./prd stat derived/storage)
dd ./prd write derived/storage --base-revision "$rev" < storage.md
```

服务提供三样东西：

- web 界面：浏览和编辑两层文档，外部改动会实时同步
- HTTP API：`/api/docs`、`/api/doc?id=<id>`
- MCP（Streamable HTTP）：`/mcp`，工具为 `list_docs`、`read_doc`、`write_doc`、`append_doc`

接入 Codex：

```sh
codex mcp add derivedoc --url http://127.0.0.1:7788/mcp
```

## 目录结构

```text
prd/
  source/        人提出的需求与讨论后定下的决定
  derived/       agent 据此维护的设计方案
  .derivedoc/    本地数据（暂未使用）
```

文档 id 是相对路径去掉 `.md`，例如 `source/requirements`。写入可以带 `base_revision`
做并发校验，不匹配会返回 `conflict`。

## 开发

```sh
npm run dd -- ./prd        # 直接跑源码（Node 24 原生执行 TS）
npm test                   # 文档存储测试
npm run typecheck          # 类型检查
npm run web:dev            # 前端开发模式，代理到 7788
npm run build              # 打包 CLI 与前端
```
