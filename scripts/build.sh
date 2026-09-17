#!/bin/bash
# Build: compile src/ → lib/ with the dsh checkout's tsc.
# Requires DSH_CHECKOUT pointing at a dsh installation (auto-probe below).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# DSH_CHECKOUT 探测：环境变量 → 常见路径
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/node_modules/@deepseek-ai" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/node_modules/@deepseek-ai" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="./node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  TSC="$CHECKOUT/node_modules/.bin/tsc"
fi
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found (run npm install, or set DSH_CHECKOUT to a checkout with typescript)" >&2
  exit 1
fi

link_pkg() {
  # link_pkg <node_modules 相对路径> <checkout 内目标候选1> [候选2...]
  local name="$1"; shift
  local target=""
  for cand in "$@"; do
    if [ -e "$CHECKOUT/$cand" ]; then target="$CHECKOUT/$cand"; break; fi
  done
  if [ -z "$target" ]; then
    echo "build: dependency target missing for $name (tried: $*)" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$name" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
# 源码 checkout 布局（vendor/, packages/）与 npm 安装布局（node_modules/@deepseek-ai/）双兼容
link_pkg @deepseek-ai/cordis vendor/cordis node_modules/@deepseek-ai/cordis
link_pkg @deepseek-ai/schemastery vendor/schemastery node_modules/@deepseek-ai/schemastery
link_pkg @deepseek-ai/dsh-llm packages/llm/llm node_modules/@deepseek-ai/dsh-llm
link_pkg @deepseek-ai/dsh-agent packages/core/agent node_modules/@deepseek-ai/dsh-agent
link_pkg @types/node node_modules/@types/node

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
