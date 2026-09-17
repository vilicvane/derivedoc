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
    printf '%s' "$payload" | DERIVEDOC_CAPTURE=1 exec node "$(dirname "$0")/capture.mjs" "$dir"
  fi
  dir=$(dirname "$dir")
done

# 往上找不到：可能工作区在当前目录下面（比如仓库根下的 prd/），交给 node 查注册表。
printf '%s' "$payload" | DERIVEDOC_CAPTURE=1 exec node "$(dirname "$0")/capture.mjs" ""
