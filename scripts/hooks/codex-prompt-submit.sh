#!/bin/bash
# derivedoc · Codex UserPromptSubmit 钩子
#
# 只做一件便宜的事：判断当前会话是否在 derivedoc 工作区里。在，就把这条用户消息交给
# capture.mjs 起子会话处理；不在，直接放行（一次向上 stat，几乎零成本）。
#
# 注意：这个钩子是阻塞的——它返回之前，主会话不会开始生成。整条链路依赖这一点。

set -u

# 捕获子会话自己触发钩子时直接放行，避免递归。
if [ -n "${DERIVEDOC_CAPTURE:-}" ]; then
  exit 0
fi

payload=$(cat)
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
[ -n "$cwd" ] || cwd=$PWD

dir=$(cd "$cwd" 2>/dev/null && pwd) || exit 0

while [ "$dir" != / ]; do
  if [ -d "$dir/.derivedoc" ]; then
    # 管道右侧运行在子 shell 中，不能靠 exec 结束当前脚本；显式退出以免继续走兜底分支。
    printf '%s' "$payload" | node "$(dirname "$0")/capture.mjs" "$dir"
    exit $?
  fi
  dir=$(dirname "$dir")
done

# 往上找不到：可能项目在当前目录下面（当前目录是它的父级），交给 node 查注册表。
printf '%s' "$payload" | node "$(dirname "$0")/capture.mjs" ""
