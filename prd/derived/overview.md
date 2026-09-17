# derivedoc 总览

**依据**：[产品定位与痛点](../source/product.md) · [两层文档的边界](../source/two-layers.md)

## 是什么

项目级文档服务：`source` 沉淀人和 agent 讨论后定下的决定，`derived` 承载据此外化的设计
方案。人和 agent 共用同一份文件，`dd` 同时提供界面与接口。

要解决的是漂移：上下文压缩会丢细节，agent 不回头查就会凭大方向继续做，等主线完成时
细节已经和当初的决定不一致。

## 两层怎么协作

- 用户消息或讨论产生**决定**，落到 `source`。source 只记决定，不记结论和推导。
- agent 根据 source 维护 `derived`，落地过程中可以灵活调整。
- 落地阶段 source 原则上不动；只有被明确授权（如无值守）时 agent 才能改，且要留 diff
  或先追加未合并条目。
- 不做精确覆盖追踪：是否同步、影响哪些文档，由 agent 读了之后判断。

## 当前状态

M1 已完成，工具已经能自己用：

- 文档存储与并发保护（[文档模型](document-model.md)）
- CLI 读写（[命令行](cli.md)）
- 本地服务：web 界面、HTTP API、MCP（[服务](server.md)）

尚未实现：用户消息的自动沉淀、思考注入、会话通知与派生队列（[对话捕获](capture.md)、
[通知与排队](session-sync.md)）。这几项目前靠人和 agent 手动完成。

## 目录约定

本仓库就是 derivedoc 自己的项目根：`.derivedoc/` 在仓库里，`prd/` 是指定的文档目录，
它的 `source/` 放决定，`derived/` 放方案。
