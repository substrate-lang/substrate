#!/usr/bin/env bash
# Lifecycle: experimental.
#
# The browser tests for the new compiler. They run in headless Chromium
# (host/web/browser.mjs). They are separate from tests/run.sh, which
# needs no browser. Run them in the dev shell:
#
#   tests/web/run.sh
#
# Each test page is built as a small static web site under build/web
# (or OUT/web if OUT is set). There are two groups of tests.
#
# 1. The compiler running in a page. The site "session" contains the
#    compiler's own build as the page's program, and a file pack with the
#    library sources and the session tests (tests/session). The page
#    session.html evaluates one session test, exactly as `bin/sub eval`
#    does on the command line, and session.mjs checks that the output
#    equals the test's .out file.
#
# 2. Pages written with lib/web/ui.sub. pages.mjs opens each one, clicks
#    and types, and checks what the page shows:
#      counter, rows   the examples in lib/web/examples
#      snake           the snake game (lib/web/examples/snake)
#      platformer      the platformer (lib/web/examples/platformer),
#                      built on the game library (lib/web/game)
#      blocks          the world of blocks (lib/web/examples/blocks),
#                      drawn in 3D by the GPU
#      valley          the valley (lib/web/examples/valley), a landscape
#                      drawn in 3D by the GPU
#      sounds          a game that plays a sound file, once and as music
#                      (sounds.sub)
#      gpu             the host module "gpu" (host/web/gpu.mjs) used
#                      directly: drawing into a texture, a compute shader
#                      and a shader error, each read back (gpu.sub)
#      sprites, sprites-canvas
#                      the game that draws many sprites (sprites-world.sub),
#                      drawn by the GPU renderer (lib/web/scene/sprites.sub)
#                      and by the 2D canvas: both draw the same picture.
#                      These are also the pages that sprites.mjs measures
#      stopped, stopped-at-start
#                      games that trap, in a step and while starting: the
#                      game must stop and show the report (stopped.sub,
#                      stopped-at-start.sub)
#      focus           an event that fires while the page is being updated
#                      (focus.sub)
#      fields          typed attributes and event data (fields.sub)
#      assets          a program's assets: one read as a file, one drawn
#                      on a canvas and shown by an <img> (assets.sub, and
#                      the directory assets)
#      canvas          canvas drawing, window listeners and animation
#                      frames (canvas.sub)
#      guests          sandboxed programs (guests.sub; its guests run
#                      a-guest.sub, which is put in the site as a file
#                      pack)
#      repl            the REPL page (lib/web/repl)
#
# rows.mjs and sprites.mjs are not part of the tests. They measure how
# long the operations of the rows example take, and how long the two
# renderers take to draw many sprites.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
sites="${OUT:-build}/web"

# Make sure the compiler's build (build/sub) is up to date before it
# is copied into a site. bin/sub rebuilds it when the compiler's sources
# have changed, and expanding an empty file is the cheapest command that
# triggers this.
mkdir -p build
: > build/empty.sub
bin/sub expand build/empty.sub > /dev/null

site="$sites/session"
rm -rf "${site:?}"
mkdir -p "$site/host/web"
cp host/subhost-core.mjs "$site/host/"
cp host/web/subhost-web.mjs "$site/host/web/"
cp -r build/sub "$site/program"
host/web/pack.mjs -o "$site/files.pack" compiler/print.sub compiler/memory.sub compiler/numbers.sub compiler/kernel.sub compiler/kernel-forms.sub compiler/syntax-match.sub compiler/patterns.sub compiler/base lib/substrate lib/bend tests/session
cp tests/web/session.html "$site/index.html"
status=0
node tests/web/session.mjs "$site" kernel substrate c switch bend || status=1

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
