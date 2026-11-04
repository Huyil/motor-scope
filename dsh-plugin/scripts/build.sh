#!/bin/bash
# Build dsh-motorscope: both halves are plain ESM/JS, so this only stages lib/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf lib
mkdir -p lib
cp src/index.js lib/index.js
cp src/client.js lib/client.js

echo "built: lib/index.js + lib/client.js"
