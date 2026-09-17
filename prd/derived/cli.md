# 命令行

**依据**：[人与 agent 的接口](../source/interfaces.md)

`dd <目录>` 不带子命令会启动服务；带子命令则是纯文档读写，不需要服务在场。

## 命令

| 命令 | 说明 |
| --- | --- |
| `dd <目录> root [--json]` | 打印所属的 derivedoc 工作区；不在工作区则退出码 1 |
| `dd <目录> ls [--kind source\|derived] [--json]` | 列出文档 |
| `dd <目录> read <id> [--json]` | 打印正文；`--json` 输出含 `revision` 与 `frontmatter` |
| `dd <目录> stat <id> [--json]` | 只打印修订号 |
| `dd <目录> write <id> [--base-revision <rev>]` | 整篇写入 |
| `dd <目录> append <id>` | 追加到文末 |
| `dd <目录> rm <id> [--base-revision <rev>]` | 删除 |

写入内容按优先级取自 `--content`、命令行剩余参数、stdin。

## 工作区判定

`root` 从给定目录往上逐级查找 `.derivedoc/`，只认这一个标记——普通项目也常有 `source/`
目录，不能只看目录名。命中就把工作区根路径打印出来，没命中退出码 1。

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
dd ./prd append source/requirements '## 决定：先用 CLI 接入'
rev=$(dd ./prd stat derived/storage)
dd ./prd write derived/storage --base-revision "$rev" < storage.md
dd ./prd ls --kind derived --json
```

`dd` 与 coreutils 的 `dd` 同名，必要时用 `derivedoc` 这个 bin 名。
