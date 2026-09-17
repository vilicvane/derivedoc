# 文档模型

**依据**：[两层文档的边界](../source/two-layers.md)

## 目录结构

```text
<项目>/
  source/        决定
  derived/       方案
  .derivedoc/    本地运行数据
    conversations/
      <session-id>.jsonl  对话日志；每个会话一份，只追加不改写；供 source 决定追溯发言者与时间
```

## 标识与标题

- 文档 id = 相对路径去掉 `.md`，必须落在 `source/` 或 `derived/` 下，例如
  `source/product`。
- 标题优先取 frontmatter 的 `title`，其次取正文首个一级标题，最后回落到 id。
- frontmatter 完全可选，工具不会往文档里写额外字段。

## 版本与并发

- `revision` = 全文（含 frontmatter）的 SHA-256 前 12 位。它是并发校验与变更判定的依据。
- `updatedAt` 取文件 mtime，只用于展示与排序。
- 写入是原子的：先写临时文件再 rename。
- 写入可带 `baseRevision`，不匹配返回 `conflict`，调用方需要重新读取后再写。
- 文件监听（chokidar）忽略 `.derivedoc`、`node_modules`、`.git`；外部改动会广播到
  web 与 API 的订阅方。自己写入触发的回声按 revision 去重。

## 追加语义

`append` 在文末追加内容，用一个空行与原内容分隔；文档不存在时以追加内容作为初始正文。

## 关联与反查

- 约定：derived 文档开头写一行 `**依据**：` 指向对应的 source；source 文档开头写一行
  `**落地**：` 指向对应的 derived。用项目内相对链接，例如
  `[两层文档的边界](../source/two-layers.md)`。
- 链接以当前文档路径为基准解析成文档 id；`http(s):` 外链、纯锚点和越出 `source/`、
  `derived/` 的路径不算引用。
- 工具从正文抽出引用（`DocMeta.links`），服务提供 `/api/backlinks?id=` 做反查，界面在
  文档顶部显示「引用 / 被引用」并支持点击跳转。
- 指向不存在文档的链接会被保留：界面按 id 显示，反查自然为空。

## 初始化行为

`dd <目录>` 只会在项目首次建立时补一篇占位 `source/requirements.md`；用户删掉之后不会
自动补回来。
