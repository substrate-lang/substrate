#!/usr/bin/env bash
# The many-sprites game, timed in headless Chromium with the 2D context and with WebGPU. With `hardware`, it is also
# timed on the machine's GPU.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
sites=build/bench/web
bin/substrate site "$sites/sprites" tests/web/sprites.sub -p tests/web/sprites.html
bin/substrate site "$sites/sprites-canvas" tests/web/sprites-canvas.sub -p tests/web/sprites.html
node "$here/sprites.mjs" "$sites" "$@"
