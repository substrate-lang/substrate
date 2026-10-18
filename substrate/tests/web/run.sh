#!/usr/bin/env bash
# The browser tests, in headless Chromium: the compiler in a page, then each test page.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
sites="${OUT:-build}/web"

# Expanding an empty file is the cheapest way to have bin/sub bring build/sub up to date.
mkdir -p build
: > build/empty.sub
bin/sub expand build/empty.sub > /dev/null

site="$sites/session"
rm -rf "${site:?}"
mkdir -p "$site/host/web"
cp host/subhost-core.mjs "$site/host/"
cp host/web/subhost-web.mjs "$site/host/web/"
cp -r build/sub "$site/program"
host/web/pack.mjs -o "$site/files.pack" compiler/print.sub compiler/memory.sub compiler/numbers.sub compiler/writer.sub compiler/kernel.sub compiler/kernel-forms.sub compiler/syntax-match.sub compiler/patterns.sub compiler/base lib/syntax-match.sub lib/forms.sub lib/nodes.sub lib/scheme lib/bend tests/session
cp tests/web/session.html "$site/index.html"
status=0
node tests/web/session.mjs "$site" kernel scheme base switch bend || status=1

lib/web/site.sh lib/web/examples/counter.sub "$sites/counter"
lib/web/site.sh lib/web/examples/rows.sub "$sites/rows"
lib/web/repl/site.sh "$sites/repl"
lib/web/site.sh tests/web/focus.sub "$sites/focus"
lib/web/site.sh tests/web/fields.sub "$sites/fields"
lib/web/site.sh tests/web/assets.sub "$sites/assets"
lib/web/site.sh tests/web/canvas.sub "$sites/canvas"
lib/web/site.sh lib/web/examples/snake/snake.sub "$sites/snake" lib/web/examples/snake/page.html
lib/web/site.sh lib/web/examples/platformer/platformer.sub "$sites/platformer" lib/web/examples/platformer/page.html
lib/web/site.sh lib/web/examples/blocks/blocks.sub "$sites/blocks" lib/web/examples/blocks/page.html
lib/web/site.sh lib/web/examples/valley/valley.sub "$sites/valley" lib/web/examples/valley/page.html
# The sounds page uses the platformer's page, which keeps the audio module
# where the test can ask it what was played.
lib/web/site.sh tests/web/sounds.sub "$sites/sounds" lib/web/examples/platformer/page.html
lib/web/site.sh tests/web/stopped.sub "$sites/stopped"
lib/web/site.sh tests/web/stopped-at-start.sub "$sites/stopped-at-start"
lib/web/site.sh tests/web/gpu.sub "$sites/gpu" tests/web/gpu.html
lib/web/site.sh tests/web/sprites.sub "$sites/sprites" tests/web/sprites.html
lib/web/site.sh tests/web/sprites-canvas.sub "$sites/sprites-canvas" tests/web/sprites.html
lib/web/site.sh tests/web/guests.sub "$sites/guests" tests/web/guests.html
bin/sub build tests/web/a-guest.sub -o "$sites/guests/guest"
host/web/pack.mjs -o "$sites/guests/guest.pack" -C "$sites/guests/guest" .
rm -r "${sites:?}/guests/guest"
node tests/web/pages.mjs "$sites" counter rows focus fields assets canvas snake platformer sounds stopped stopped-at-start \
  guests repl gpu sprites sprites-canvas blocks valley || status=1
exit $status
