# 服务

**依据**：[人与 agent 的接口](../source/interfaces.md)

命令行输出与界面文案统一用「工作区」指代一个被 `dd` 管理的目录——这是实现时的取名，
不是产品决定。

`dd` 会初始化工作区、启动本地服务并打印地址（项目根与文档目录分两行）。默认监听
`127.0.0.1:7788`，端口被占用时自动顺延（最多 10 个）。

加 `--dev` 进入开发模式：服务启动时顺带跑 Vite 的 watch 构建，每次构建完成通过已有的
WebSocket 通知页面自己刷新，省掉手动刷新。之所以不用 Vite dev server 直接托管前端——
Monaco 会让 dev server 反复重做依赖优化并整页刷新（实测一次加载发 18000 个请求、自动刷新
5 次），watch 构建要稳得多，代价是每次改动多等一次约 1 秒的构建。Monaco 也改成了只引
编辑器核心与 markdown 高亮，前端包从 4.4MB 降到 3.3MB（gzip 846KB）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok, root, docs, files}`：项目根、文档目录、文档篇数 |
| GET | `/api/docs?kind=` | 文档列表（元数据） |
| GET | `/api/resolve?path=&docs=` | 这条路径属于哪个工作区、文档目录在哪、要不要新建 |
| GET | `/api/doc?id=` | 单篇正文，含 `revision` 与 `frontmatter` |
| GET | `/api/search?q=` | 标题与正文全文检索，命中带 `snippet` |
| GET | `/api/backlinks?id=` | 反查谁引用了这篇 |
| GET/PUT/DELETE | `/api/selection` | 界面选中的那段：读、记、清 |
| PUT/POST | `/api/doc?id=` | 写入，body 为 `{content, baseRevision?}` |
| DELETE | `/api/doc?id=` | 删除 |

错误统一是 `{error:{code, message, ...}}`，状态码 404（不存在）、409（冲突）、400（用法）。

## 变更推送

`/ws` 是 WebSocket，连接后先收到 `{type:"ready", defaultId}`，之后收到
`{type:"created"|"changed"|"deleted", id, kind, revision, updatedAt}`。

## 文档改动与提交

改动以 git 为准，范围固定为文档目录里的 `source/` 与 `derived/` 两层：git 从项目根跑，
命令里的路径带上文档目录前缀（`prd/source` 这样），接口吐出来的 `changes[].path` 仍是相对
文档目录的 `source/…`，界面与 agent 不用关心项目根在哪。

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

界面可切换的工作区列表来自用户级注册表 `~/.config/derivedoc/workspaces.json`（受
`XDG_CONFIG_HOME` 影响），每条记项目根与文档目录（`root` / `docs`）；列表里显示路径用的是
文档目录，工作区之间真正的差别在那里。

加工作区走界面里的表单：填项目根与文档目录（文档目录默认 `ddoc/`，服务端用
`GET /api/resolve` 先认一遍，已有项目会自动填成记下的那个），`POST /api/workspaces` 的 body
是 `{root, docs?}`，没有 `.derivedoc/` 时就地建一个。

注册表早期放在 `~/.derivedoc/workspaces.json`，而 `.derivedoc` 正是项目标记——家目录因此会被
向上查找认成项目根。现在写一律写新位置，只在读的时候兼容旧文件；`isProjectRoot` 也显式排除
家目录。

## 选中内容

文档页里选中一段（非空）就 `PUT /api/selection`，服务端把 `{doc, from, to, quote, revision,
at, channel}` 覆盖写进项目根下的 `.derivedoc/selection.json`；空选区不动已有记录，清除按钮走
`DELETE`。只留最近一次——它是「现在指哪儿」，不是历史。

agent 侧读的是 `dd selection`（`--json` 给结构）；没有就退出码 1。

界面上的提示用 Monaco 的 content widget 挂在选区开头**上方**（贴着选区、又不压住它），左边缘
与选区起点对齐，source 色实底 + 白字写着「已选中，agent 可读」。拖拽过程中不显示——widget
压在正文上会挡住正在拉的选区；松手之后才贴出来。widget 整体不接鼠标事件
（`pointer-events: none`），压在正文上也点得透。

提示与记录同生共死：选区收起来（点别处、换文档）就把 `.derivedoc/selection.json` 撤掉，
不留下「agent 手里有一段、界面上却看不出来」的状态。

web 界面由 Vite 构建到 `bld/web`，由服务托管（产物不存在时返回占位页并提示去构建）。

前端用 react-router 的真实路径路由，服务端对非静态资源的路径回落到 `index.html`：

| 路径 | 内容 |
| --- | --- |
| `/` | 打开后自动跳到第一篇 source 文档 |
| `/d/<id>` | 某篇文档（编辑器） |
| `/d/<id>?diff=1` | 同一篇的 diff 视图 |
| `/changes` | 审阅并提交改动 |

选中哪篇、在看 diff 还是编辑、是否在提交页，全都由 URL 决定，浏览器前进/后退和刷新都保持
原样；深链接可以直接发给别人。

现有能力：

- 侧栏是目录树：`source` / `derived` 两个根，下面按实际目录继续嵌套；每个文档先显示文件名
  （等宽小字），再显示标题（粗体）。文件夹可以折叠，根节点带文档计数与「＋」新建。
- 文档条目上带改动提示：未保存草稿是圆点，git 未提交改动是「新增 / 修改 / 删除」标签。
- 打开文档时按有无改动决定初始视图：有改动先进 diff，没有就进编辑器；顶部「diff / 编辑」
  按钮随时切换。冲突时横幅里的「看差异」也是同一个 diff 视图。
- 编辑与阅读是一个界面：Monaco 编辑器即阅读视图（markdown 高亮），不再有独立的阅读模式和
  渲染预览。
- 顶部显示 id 与修订号，另有「变更 N」（提交面板）、「重新载入」、「删除」、「保存」；
  `Ctrl/Cmd+S` 保存，`Esc` 关闭 diff。
- 键盘：侧栏聚焦时 `↑` `↓` 切换文档，`Ctrl/Cmd+K` 聚焦搜索框，`Ctrl/Cmd+S` 保存，
  `Esc` 关闭 diff。
- 过滤词非空时走 `/api/search` 做全文检索，命中显示片段。
- 外部改动经 WebSocket 实时同步：无草稿时自动重载，有草稿时不覆盖，改为横幅提示并提供
  「看差异」（草稿 vs 磁盘新版本）与「用磁盘版本」。
- 自己写入触发的回声按内容比对识别，不会误报成外部改动。

视觉与反馈约定：

- 方向是编辑/印刷感：纸色底 `--paper #f6f2e9`、墨色文字 `--ink #1b1917`、发丝分隔线，
  文档标题用衬线（Iowan Old Style / Georgia / 宋体回退），正文与控件用无衬线。
- 两层文档用冷暖对撞区分：source 朱砂 `#b23a1a`（人的决定），derived 石青 `#1d5a8e`
  （agent 维护）。侧栏层标签、选中项左边线、文件名都跟层色走；正文区不跟着染色。
- 层次靠纸色与 hairline，不用圆角卡片 + 轻阴影那一套；控件是 4px 小圆角、透明底 + 细边框，
  hover 填充纸色，主按钮用墨色实心。
- 侧栏：文件夹标签后面紧跟计数（不推到最右边），新建「＋」常显。
- 编辑器有配套的 Monaco 主题（`derivedoc-light` / `derivedoc-dark`），标题、链接、代码块的
  颜色与界面一致，并且跟随系统深浅色切换。
- 深色模式是同一套逻辑的墨底版本（`--paper #16140f`），不是简单反色。
- 状态反馈用浮层 toast（成功 / 提示 / 错误三态，约 3 秒自动消失），不再是底部状态行。
- 文档条目同时承载文件名与标题：文件名是等宽小字在上，标题是粗体在下，右侧带草稿圆点与
  git 变更标签。
- 新建文档走 `POST /api/doc`（createOnly）：同名会明确报「已存在同名文档」而不是静默覆盖；
  建完自动展开所在目录、进入编辑器并把光标交给编辑器，而不是先进 diff。

Monaco 的打包约定：

- 本地打包，不走 CDN：`loader.config({monaco})`。
- 所有语言共用基础 editor worker（`MonacoEnvironment.getWorker`），因为只编辑 markdown；
  另外要设 `worker.format = 'es'`，否则 worker 里的 ESM 引用会解析失败并在控制台报错。
- Monaco 单独成块（`manualChunks`），界面代码约 325KB，Monaco 约 4.4MB（gzip 1.1MB），两者
  并行加载；构建仍会产出 ts/css/html/json 的 worker 文件，但运行时不会去取。
