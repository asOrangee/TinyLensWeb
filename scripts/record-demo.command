#!/bin/zsh
set -eu

script_dir="${0:A:h}"
bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [[ -x "$bundled_node" ]]; then
  node_bin="$bundled_node"
elif command -v node >/dev/null; then
  node_bin="$(command -v node)"
else
  print -u2 '需要 Node.js 和 Playwright 才能运行 TinyLens 录制脚本。'
  exit 1
fi

exec "$node_bin" "$script_dir/record-demo.mjs" "$@"
