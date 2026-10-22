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
bin/sub site "$site" build/sub -p tests/web/session.html -f files compiler host lib/nodes.sub lib/scheme lib/bend tests/session
status=0
node tests/web/session.mjs "$site" funcs scheme substrate switch bend || status=1

bin/sub site "$sites/counter" lib/web/examples/counter.sub
bin/sub site "$sites/rows" lib/web/examples/rows.sub
make -s repl OUT="${OUT:-build}"
bin/sub site "$sites/focus" tests/web/focus.sub
bin/sub site "$sites/floor" tests/web/floor.sub
bin/sub site "$sites/storage" tests/web/storage.sub
bin/sub site "$sites/location" tests/web/location.sub
bin/sub site "$sites/clipboard" tests/web/clipboard.sub
bin/sub site "$sites/files" tests/web/files.sub
bin/sub site "$sites/fields" tests/web/fields.sub
bin/sub site "$sites/assets" tests/web/assets.sub
bin/sub site "$sites/canvas" tests/web/canvas.sub
bin/sub site "$sites/snake" lib/web/examples/snake/snake.sub -p lib/web/examples/snake/page.html
bin/sub site "$sites/platformer" lib/web/examples/platformer/platformer.sub -p lib/web/examples/platformer/page.html
bin/sub site "$sites/blocks" lib/web/examples/blocks/blocks.sub -p lib/web/examples/blocks/page.html
bin/sub site "$sites/valley" lib/web/examples/valley/valley.sub -p lib/web/examples/valley/page.html
bin/sub site "$sites/sounds" tests/web/sounds.sub -p lib/web/examples/platformer/page.html
bin/sub site "$sites/stopped" tests/web/stopped.sub
bin/sub site "$sites/stopped-at-start" tests/web/stopped-at-start.sub
bin/sub site "$sites/gpu" tests/web/gpu.sub -p tests/web/gpu.html
bin/sub site "$sites/sprites" tests/web/sprites.sub -p tests/web/sprites.html
bin/sub site "$sites/sprites-canvas" tests/web/sprites-canvas.sub -p tests/web/sprites.html
bin/sub site "$sites/guests" tests/web/guests.sub -p tests/web/guests.html -g guest tests/web/a-guest.sub
node tests/web/pages.mjs "$sites" counter rows focus floor storage location clipboard files fields assets canvas snake platformer \
  sounds stopped stopped-at-start guests repl gpu sprites sprites-canvas blocks valley || status=1
exit $status
