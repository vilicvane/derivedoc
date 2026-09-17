# 两层文档的边界

**落地**：[derivedoc 总览](../derived/overview.md) · [文档模型](../derived/document-model.md) · [对话捕获](../derived/capture.md)

## 决定：source 只沉淀决定

不是结论，更不是推理过程。判据是能不能从别处重新推导：决定是人做的选择，推不出来；
结论是推理的产物，依据还在就能重推。

## 决定：source 保持高层精简

粒度是「关于某些点的决定」。大量内容可以写在一个文件里，也可以分散成很多文件，或者
分散但用链接串起来，由用户自己组织。

## 决定：derived 由 agent 根据 source 维护

落地阶段 agent 可以根据实际进展灵活调整 derived。

## 决定：两层之间用链接互相引用

source 里指向落地的 derived，derived 里指向依据的 source。不用 frontmatter 字段做结构化
覆盖追踪，链接本身就是关系。

## 决定：source 在落地阶段原则上不动

只有用户明确授权 agent 自行处理（比如无值守开发）时才允许改。这时必须有合适的 diff
展示机制，或者先追加为未合并的 source 条目，等用户交互时再合并。

## 决定：中文用「派生」对应 derived

代码、目录和标识符里仍然用 `derived`。
