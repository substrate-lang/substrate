#!/usr/bin/env bash
# The browser tests, in headless Chromium: the compiler in a page, then each test page.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
sites="${OUT:-build}/web"

mkdir -p build
: > build/empty.sub
bin/sub expand build/empty.sub > /dev/null

site="$sites/session"
host/web/site.sh "$site" build/sub -p tests/web/session.html -f files compiler/substrate.sub compiler/wasm.sub \
  compiler/writer.sub compiler/syntax.sub compiler/macros.sub host/host.sub host/fs.sub lib/nodes.sub lib/scheme lib/bend tests/session
status=0
node tests/web/session.mjs "$site" funcs scheme substrate switch bend || status=1

host/web/site.sh "$sites/counter" lib/web/examples/counter.sub
host/web/site.sh "$sites/rows" lib/web/examples/rows.sub
make -s repl OUT="${OUT:-build}"
host/web/site.sh "$sites/focus" tests/web/focus.sub
host/web/site.sh "$sites/floor" tests/web/floor.sub
host/web/site.sh "$sites/fields" tests/web/fields.sub
host/web/site.sh "$sites/assets" tests/web/assets.sub
host/web/site.sh "$sites/canvas" tests/web/canvas.sub
host/web/site.sh "$sites/snake" lib/web/examples/snake/snake.sub -p lib/web/examples/snake/page.html
host/web/site.sh "$sites/platformer" lib/web/examples/platformer/platformer.sub -p lib/web/examples/platformer/page.html
host/web/site.sh "$sites/blocks" lib/web/examples/blocks/blocks.sub -p lib/web/examples/blocks/page.html
host/web/site.sh "$sites/valley" lib/web/examples/valley/valley.sub -p lib/web/examples/valley/page.html
host/web/site.sh "$sites/sounds" tests/web/sounds.sub -p lib/web/examples/platformer/page.html
host/web/site.sh "$sites/stopped" tests/web/stopped.sub
host/web/site.sh "$sites/stopped-at-start" tests/web/stopped-at-start.sub
host/web/site.sh "$sites/gpu" tests/web/gpu.sub -p tests/web/gpu.html
host/web/site.sh "$sites/sprites" tests/web/sprites.sub -p tests/web/sprites.html
host/web/site.sh "$sites/sprites-canvas" tests/web/sprites-canvas.sub -p tests/web/sprites.html
host/web/site.sh "$sites/guests" tests/web/guests.sub -p tests/web/guests.html -g guest tests/web/a-guest.sub
node tests/web/pages.mjs "$sites" counter rows focus floor fields assets canvas snake platformer sounds stopped stopped-at-start \
  guests repl gpu sprites sprites-canvas blocks valley || status=1
exit $status
