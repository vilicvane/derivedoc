# 服务

**依据**：[人与 agent 的接口](../source/interfaces.md)

`dd <目录>` 会初始化目录、启动本地服务并打印地址。默认监听 `127.0.0.1:7788`，端口被占用
时自动顺延（最多 10 个）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok, root, docs}` |
| GET | `/api/docs?kind=` | 文档列表（元数据） |
| GET | `/api/doc?id=` | 单篇正文，含 `revision` 与 `frontmatter` |
| GET | `/api/search?q=` | 标题与正文全文检索，命中带 `snippet` |
| GET | `/api/backlinks?id=` | 反查谁引用了这篇 |
| PUT/POST | `/api/doc?id=` | 写入，body 为 `{content, baseRevision?}` |
| DELETE | `/api/doc?id=` | 删除 |

错误统一是 `{error:{code, message, ...}}`，状态码 404（不存在）、409（冲突）、400（用法）。

## 变更推送

`/ws` 是 WebSocket，连接后先收到 `{type:"ready", root}`，之后收到
`{type:"created"|"changed"|"deleted", id, kind, revision, updatedAt}`。

## 文档改动与提交

改动以 git 为准，范围固定为工作区里的 `source/` 与 `derived/` 两层。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/git/status` | `{available, reason?, branch?, changes[], message?}` |
| GET | `/api/git/diff?path=` | 返回 diff 文本，含未跟踪新文件 |
| POST | `/api/git/commit` | body `{message?}`，缺省用 `.derivedoc/commit-message` |

- 工作区不在 git 仓库里时 `available` 为 false，界面显示原因，不做任何自动初始化。
- 提交只包含两层文档：先把这两层 `git add`，再用 `git commit -- <层>`，因此用户其它已暂存
  的内容不会被带进这次提交。
- 提交成功后清空 `.derivedoc/commit-message`。
- 界面里的「变更 N」按钮打开提交面板：文件列表、可点的 diff、commit message 输入框和提交
  按钮；message 为空时按改动文件自动草拟一句。
- `.derivedoc/` 下写了 `.gitignore`（内容为 `*`），运行时数据不进版本库。

## MCP

`/mcp` 是 Streamable HTTP 通道，stateless：每个请求一套 server + transport，用完即弃。
工具为 `list_docs`、`read_doc`、`write_doc`、`append_doc`，写入同样支持 `base_revision`。

```sh
codex mcp add derivedoc --url http://127.0.0.1:7788/mcp
```

MCP 是可选通道；给 agent 的默认接口是 [命令行](cli.md)。

## 界面

web 界面由 Vite 构建到 `bld/web`，由服务托管（产物不存在时返回占位页并提示去构建）。

现有能力：

- 侧栏按 source / derived 分组，带计数、过滤框和「＋」新建；过滤词非空时走
  `/api/search` 做全文检索，命中显示片段。
- 阅读态渲染 markdown，文档内相对链接直接跳转，找不到的目标会给提示。
- 编辑态用 Monaco（markdown 高亮、查找替换、多光标）；草稿按文档存在内存里，切走再切回来
  不丢，侧栏对应条目显示小圆点。
- 差异一律用 Monaco 的 DiffEditor 并排展示：顶部「改动」看草稿与磁盘现状，冲突时看草稿与
  磁盘新版本，提交面板里看已提交版本与工作区。
- 顶部显示 id 与修订号，支持「改动」查看草稿与磁盘现状的行级 diff、「重新载入」、「删除」、
  「保存」；`Ctrl/Cmd+S` 保存，`Esc` 退出编辑态。
- 外部改动经 WebSocket 实时同步：无草稿时自动重载，有草稿时不覆盖，改为横幅提示并提供
  「看差异」（草稿 vs 磁盘新版本）与「用磁盘版本」。
- 自己写入触发的回声按内容比对识别，不会误报成外部改动。

Monaco 的打包约定：

- 本地打包，不走 CDN：`loader.config({monaco})`。
- 所有语言共用基础 editor worker（`MonacoEnvironment.getWorker`），因为只编辑 markdown；
  另外要设 `worker.format = 'es'`，否则 worker 里的 ESM 引用会解析失败并在控制台报错。
- Monaco 单独成块（`manualChunks`），界面代码约 325KB，Monaco 约 4.4MB（gzip 1.1MB），两者
  并行加载；构建仍会产出 ts/css/html/json 的 worker 文件，但运行时不会去取。
