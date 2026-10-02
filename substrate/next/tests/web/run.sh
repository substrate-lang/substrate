#!/usr/bin/env bash
# Lifecycle: experimental.
#
# The browser tests for the new compiler. They run in headless Chromium
# (host/web/browser.mjs). They are separate from next/tests/run.sh, which
# needs no browser. Run them in the dev shell:
#
#   next/tests/web/run.sh
#
# Each test page is built as a small static web site under build/next/web
# (or OUT/next/web if OUT is set). There are two groups of tests.
#
# 1. The compiler running in a page. The site "session" contains the
#    compiler's own build as the page's program, and a file pack with the
#    library sources and the session tests (next/tests/session). The page
#    session.html evaluates one session test, exactly as `next/sub eval`
#    does on the command line, and session.mjs checks that the output
#    equals the test's .out file.
#
# 2. Pages written with next/web/ui.sub. pages.mjs opens each one, clicks
#    and types, and checks what the page shows:
#      counter, rows   the examples in next/web/examples
#      focus           an event that fires while the page is being updated
#                      (focus.sub)
#      fields          typed attributes and event data (fields.sub)
#      guests          sandboxed programs (guests.sub; its guests run
#                      a-guest.sub, which is put in the site as a file
#                      pack)
#      repl            the REPL page (next/web/repl)
#
# rows.mjs is not part of the tests. It measures how long the operations
# of the rows example take.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
sites="${OUT:-build}/next/web"

# Make sure the compiler's build (build/next/sub) is up to date before it
# is copied into a site. next/sub rebuilds it when the compiler's sources
# have changed, and expanding an empty file is the cheapest command that
# triggers this.
mkdir -p build/next
: > build/next/empty.sub
next/sub expand build/next/empty.sub > /dev/null

site="$sites/session"
rm -rf "${site:?}"
mkdir -p "$site/host/web"
cp host/subhost-core.mjs "$site/host/"
cp host/web/subhost-web.mjs "$site/host/web/"
cp -r build/next/sub "$site/program"
host/web/pack.mjs -o "$site/files.pack" lib/print.sub next/c next/compiler/kernel.sub next/compiler/numbers.sub \
  next/substrate next/bend next/tests/session
cp next/tests/web/session.html "$site/index.html"
status=0
node next/tests/web/session.mjs "$site" kernel substrate c switch bend || status=1

next/web/site.sh next/web/examples/counter.sub "$sites/counter"
next/web/site.sh next/web/examples/rows.sub "$sites/rows"
next/web/repl/site.sh "$sites/repl"
next/web/site.sh next/tests/web/focus.sub "$sites/focus"
next/web/site.sh next/tests/web/fields.sub "$sites/fields"
next/web/site.sh next/tests/web/guests.sub "$sites/guests" next/tests/web/guests.html
next/sub build next/tests/web/a-guest.sub -o "$sites/guests/guest"
host/web/pack.mjs -o "$sites/guests/guest.pack" -C "$sites/guests/guest" .
rm -r "${sites:?}/guests/guest"
node next/tests/web/pages.mjs "$sites" counter rows focus fields guests repl || status=1
exit $status
