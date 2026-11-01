#!/usr/bin/env bash
# The browser tests, in headless Chromium: the compiler in a page, then each test page.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
export SUBSTRATE_CACHE="$root/build/cache"
sites="${OUT:-build}/web"

mkdir -p build
rm -rf "${sites:?}"
: > build/empty.sub
bin/substrate expand build/empty.sub > /dev/null

site="$sites/session"
bin/substrate site "$site" build/compiler -p tests/web/session.html \
  -f files $(find substrate/compiler substrate/host packages/scheme packages/bend tests/session -name '*.sub' | sort) \
  packages/nodes/nodes.sub std/encoding/utf8.sub tests/web/session.map
status=0
node tests/web/session.mjs "$site" funcs scheme substrate switch bend || status=1

bin/substrate site "$sites/counter" packages/web/examples/counter.sub
bin/substrate site "$sites/rows" packages/web/examples/rows.sub
make -s repl OUT="${OUT:-build}"
bin/substrate site "$sites/focus" tests/web/focus.sub
bin/substrate site "$sites/floor" tests/web/floor.sub
bin/substrate site "$sites/events" tests/web/events.sub
bin/substrate build tests/web/server.sub -o "$sites/server"
bin/substrate site "$sites/storage" tests/web/storage.sub
bin/substrate site "$sites/location" tests/web/location.sub
bin/substrate site "$sites/clipboard" tests/web/clipboard.sub
bin/substrate site "$sites/files" tests/web/files.sub
bin/substrate site "$sites/fields" tests/web/fields.sub
bin/substrate site "$sites/assets" tests/web/assets.sub
bin/substrate site "$sites/canvas" tests/web/canvas.sub
bin/substrate site "$sites/snake" packages/web/examples/snake/snake.sub -p packages/web/examples/snake/page.html
bin/substrate site "$sites/platformer" packages/web/examples/platformer/platformer.sub -p packages/web/examples/platformer/page.html
bin/substrate site "$sites/blocks" packages/web/examples/blocks/blocks.sub -p packages/web/examples/blocks/page.html
bin/substrate site "$sites/valley" packages/web/examples/valley/valley.sub -p packages/web/examples/valley/page.html
bin/substrate site "$sites/sounds" tests/web/sounds.sub -p packages/web/examples/platformer/page.html
bin/substrate site "$sites/stopped" tests/web/stopped.sub
bin/substrate site "$sites/stopped-at-start" tests/web/stopped-at-start.sub
bin/substrate site "$sites/gpu" tests/web/gpu.sub -p tests/web/gpu.html
bin/substrate site "$sites/sprites" tests/web/sprites.sub -p tests/web/sprites.html
bin/substrate site "$sites/sprites-canvas" tests/web/sprites-canvas.sub -p tests/web/sprites.html
bin/substrate site "$sites/workers" tests/web/workers.sub -p tests/web/workers.html
bin/substrate site "$sites/sqlite" tests/web/sqlite.sub
node tests/web/pages.mjs "$sites" counter rows focus floor events storage location clipboard files fields assets canvas \
  snake platformer sounds stopped stopped-at-start workers repl gpu sprites sprites-canvas blocks valley sqlite || status=1
exit $status
