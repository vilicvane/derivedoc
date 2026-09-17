# 人与 agent 的接口

**落地**：[命令行](../derived/cli.md) · [服务](../derived/server.md) · [MVP 计划](../derived/mvp-plan.md)

## 决定：给 agent 的接口以 CLI 为主

`dd <目录> ls/read/stat/write/append/rm` 这样直接读写文档，不用起服务、不用注册 MCP。
MCP 保留为可选的常驻通道，不是使用前提。

## 决定：web 保留启动空白会话的能力

但 MVP 阶段先不做 web 内对话，重点放在用户在 web 上的操作：操作触发通知，通知交给
agent，由 agent 完成后续的派生更新与任务同步。

## 决定：现在就用这套工具维护自己的设计文档

本目录（`prd/`）就是第一份 dogfood 产物。

## 决定：文档变更用 git 展示并提供快捷提交

界面里要能看到文档改动，diff 以 git 为准；提供一键提交，commit message 可以先由变更方（捕获子会话或界面）在 .derivedoc/commit-message 里草拟。

## 决定：一个页面里访问不同工作区

界面要能直接切换工作区，而不是每个工作区一个端口、一页。用户同时开多个项目时，得能分清
自己在看哪个工作区。
