#!/usr/bin/env bash
# The many-sprites game, timed in headless Chromium with the 2D context and with WebGPU. With `hardware`, it is also
# timed on the machine's GPU.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
sites=build/bench/web
for s in sprites sprites-canvas; do (cd tests/web && "$root/bin/substrate" site "$s" -o "$root/$sites/$s"); done
node "$here/sprites.mjs" "$sites" "$@"
