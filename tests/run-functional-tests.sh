#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pnpm --dir "$repo_root" --filter @nexus/web test
cd "$repo_root"
zig build test
node tests/runtime-integration.mjs
