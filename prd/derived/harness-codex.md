# Codex 适配

**依据**：[对话如何进入文档](../source/capture.md)

以下是在 Codex CLI 0.154.0 上实测过的结论，是 [对话捕获](capture.md) 落地的前提。

## 钩子

- 事件覆盖需要的时机：`UserPromptSubmit`、`PreCompact`、`PostCompact`、`SessionStart`、
  `SessionEnd`、`SubagentStart/Stop`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、
  `Interrupt`。
- 钩子可以执行命令，也可以调用 MCP 工具；命令钩子支持 `async`，不会卡住当前这一轮。
- 钩子文件位置固定在 `$CODEX_HOME/hooks.json`，config.toml 里的 `hooks` 是结构体，
  不能用 `-c hooks=<path>` 指向别处。

## fork

- `codex exec fork <SESSION_ID> [PROMPT]` 可以 fork **进行中**的会话：主会话还在一个 turn
  里执行时 fork 成功，fork 出来的会话能看到该 turn 的用户消息，照常触发钩子并正常结束。
- 所以「用户消息发出后立刻 fork」可行，不必等主会话这一轮结束。
- TUI 的 `/fork` 以「已落盘的 prompt」为分叉点，因此有进行中 turn 的限制；headless 的
  `codex exec fork` 没有这个限制。

## 注入

- `thread/inject_items`（app-server，需 `experimentalApi` capability）可以把 raw
  Responses API items 追加进线程的 model-visible history。
- 注入 `role: assistant` 的消息后，后续 turn 会把内容当作模型自己的历史使用；注入的 item
  在 rollout 里是普通 `response_item`，带 `auto-compact` 归属，provenance 可查。
- 顺序可控：先注入 user、再注入 assistant，然后 `turn/start` 带**空 input**，模型正常
  作答。
- 注入不会打断正在跑的 turn（都跑到 completed），但也不会追溯影响已经在飞的这一轮：
  只有注入之后再有新输入时，内容才被采纳。因此注入要发生在该 turn 第一次生成之前。
- Codex 没有 DSH 那样的 surface replacement 原语，只有追加与按 turn 截断
  （`thread/revert`，以及已弃用的 `thread/rollback`）。
- 这些是 app-server 的实验方法（JSON-RPC，默认 stdio），钩子不能直接调用，需要一个协议
  客户端。

## 通知

`thread/queue/add` 等队列方法同样需要 `experimentalApi`；投递到空闲线程会立刻开一轮。
headless 的 `codex exec` 跑完当前一轮就退出，不消费队列，所以队列面向长驻的交互会话。

## 计划

适配形态：钩子触发 fork，子会话完成 source 沉淀并把思考写入 pending。完成后只向主会话
交付产物位置，不注入全文；上下文里有 derivedoc 提示时，交付内容同时原文附上该提示。

## 已知现象

- 钩子是在会话开始之后才安装的，那个已经开着的会话不会补加载它：实测本仓库主会话的几条用户
  消息一条都没进对话日志，而用同样的 cwd 手动跑钩子脚本能正常落盘。安装或修改钩子后需要新开
  会话才生效。
- 项目根可能不在当前目录上方（例如在某个父目录里工作、项目在它下面）。钩子先向上找
  `.derivedoc`，找不到再查用户级注册表，挑项目根或文档目录落在当前目录下的那个；拿到的一律
  是项目根，后面的 `dd` 调用再由 `.derivedoc/config.json` 定位文档目录。
