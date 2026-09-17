# 命令行

**依据**：[人与 agent 的接口](../source/interfaces.md)

`dd [<项目根>=.] [--doc-dir=<文档目录>] [子命令]`。不给子命令就启动服务；给子命令则是纯文档
读写，不需要服务在场。项目根默认当前目录，文档目录默认 `ddoc/`——都省略就是 `.derivedoc/`
加 `ddoc/`。已经记过的项目用记下的那个。

## 命令

| 命令 | 说明 |
| --- | --- |
| `dd [<项目根>] root [--json]` | 打印项目根；`--json` 同时给 `docs`；不在工作区则退出码 1 |
| `dd [<项目根>] ls [--kind source\|derived] [--json]` | 列出文档 |
| `dd [<项目根>] read <id> [--json]` | 打印正文；`--json` 输出含 `revision` 与 `frontmatter` |
| `dd [<项目根>] stat <id> [--json]` | 只打印修订号 |
| `dd [<项目根>] write <id> [--base-revision <rev>]` | 整篇写入 |
| `dd [<项目根>] append <id>` | 追加到文末 |
| `dd [<项目根>] rm <id> [--base-revision <rev>]` | 删除 |
| `dd [<项目根>] selection [--json]` | 打印界面上选中的那段；没有时退出码 1 |

第一位 positional 命中子命令名（`ls`、`read`…）时按「在 cwd 里跑子命令」解释，所以 `dd ls`
和 `dd . ls` 等价；项目根叫 `root` 之类时写 `dd ./root ls`。

写入内容按优先级取自 `--content`、命令行剩余参数、stdin。

## 工作区判定

位置参数是**项目根**，只认 `.derivedoc/` 这一个标记——普通项目也常有 `source/` 目录，不能只
看目录名。它自己带 `.derivedoc/` 就是项目根；没有就向上找最近的项目根（在项目的子目录里敲
`dd` 也应该能用）。显式给了 `--doc-dir` 时不做这种向上猜测：给的是哪一对就是哪一对，免得在
别处误开上层项目。

文档目录按 `--doc-dir` > `.derivedoc/config.json` > 老布局（`source/` 或 `derived/` 就在项目
根下）> `ddoc/` 的顺序确定。显式给过一次就写回配置，之后的调用可以省略。

创建不需要额外参数：`dd` 在空项目里建 `.derivedoc/` 与 `ddoc/`；`dd --doc-dir=prd` 或
`dd ./app --doc-dir=prd` 换目录与项目根。这两个位置都拿不到工作区时（比如家目录——它是用户级
注册表所在，不当作项目），直接报错而不是就地建。

成本：CLI 一次调用约 38ms（主要是 Node 启动），纯 shell 的同款向上查找几乎为零。所以
harness 钩子先用 shell 粗筛，确认在工作区里再叫 CLI。

构建产物做了代码分割：`bld/cli/main.js` 只在真正起服务时才加载 Hono / MCP / ws 那一坨，
普通子命令不必付这份成本（此前每次调用约 118ms）。

## 退出码

- `0` 成功
- `1` 文档层错误（`not_found`、`conflict`、`invalid_id`、`invalid_content`）
- `2` 用法错误（未知参数、未知子命令、缺少内容）

`--json` 下错误以 `{"error":{"code","message",...}}` 输出到 stdout，其余输出仍是 JSON，
便于脚本与 agent 直接解析。

## 示例

```sh
dd                                                  # 建工作区：.derivedoc/ + ddoc/
dd . --doc-dir=prd                                  # 文档改放 prd/
dd ./app --doc-dir=.                                # 项目根与文档目录都是 ./app
dd append source/requirements '## 决定：先用 CLI 接入'
rev=$(dd stat derived/storage)
dd write derived/storage --base-revision "$rev" < storage.md
dd ls --kind derived --json
```

`dd` 与 coreutils 的 `dd` 同名，必要时用 `derivedoc` 这个 bin 名。
