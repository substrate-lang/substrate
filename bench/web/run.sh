#!/usr/bin/env bash
# The many-sprites game in headless Chromium, drawn with the 2D context and with WebGPU; with `hardware`, also on the
# machine's GPU.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
sites=build/bench/web
bin/sub site "$sites/sprites" tests/web/sprites.sub -p tests/web/sprites.html
bin/sub site "$sites/sprites-canvas" tests/web/sprites-canvas.sub -p tests/web/sprites.html
node "$here/sprites.mjs" "$sites" "$@"
