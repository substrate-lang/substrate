#!/usr/bin/env bash
# The browser tests, in headless Chromium: the compiler in a page, then each test page.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
export SUBSTRATE_CACHE="$root/build/cache"
sites="${OUT:-build}/web"

mkdir -p build
rm -rf "${sites:?}"
mkdir -p "$sites"
sites="$(cd "$sites" && pwd)"
: > build/empty.sub
bin/substrate expand build/empty.sub > /dev/null
named() { (cd "$1" && "$root/bin/substrate" site "$2" -o "$sites/$2"); }

named tests/web session
status=0
node tests/web/session.mjs "$sites/session" funcs scheme substrate switch bend || status=1

for p in counter rows; do bin/substrate site "packages/web/examples/$p.sub" -o "$sites/$p"; done
make -s repl OUT="${OUT:-build}"
for p in focus floor events storage location clipboard files fields assets canvas stopped stopped-at-start gpu workers \
         sqlite; do
  bin/substrate site "tests/web/$p.sub" -o "$sites/$p"
done
bin/substrate build tests/web/server.sub -o "$sites/server"
for s in snake platformer blocks valley; do named packages/web "$s"; done
for s in sounds sprites sprites-canvas; do named tests/web "$s"; done
node tests/web/pages.mjs "$sites" counter rows focus floor events storage location clipboard files fields assets canvas \
  snake platformer sounds stopped stopped-at-start workers repl gpu sprites sprites-canvas blocks valley sqlite || status=1
exit $status
