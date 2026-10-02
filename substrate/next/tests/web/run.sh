#!/usr/bin/env bash
# Lifecycle: experimental. The new compiler's tests in a browser, Chromium,
# headless (host/web/browser.mjs), apart from next/tests/run.sh, which
# needs none. The sites are made in build/next/web, or OUT/next/web.
#
# First the compiler itself, in a page (host/web): the site session is the
# compiler's build as its program, the sources that sessions require as a
# file pack, and session.html, which evaluates a session test
# (next/tests/session) as next/sub eval does; what the page writes must
# be the test's .out (session.mjs).
#
# Then the pages whose programs' views are ui.sub's (next/web), each a
# site next/web/site.sh made: a counter and a table of rows
# (next/web/examples), and the page that is a session (next/web/repl);
# what each shows, after it loads and after the events it is given, is
# checked in pages.mjs, with pages of their own for an event that a patch
# causes (focus.sub) and for attributes' kinds and events' data
# (fields.sub). rows.mjs, apart, times the table's operations. In
# the dev shell:
#
#   next/tests/web/run.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
sites="${OUT:-build}/next/web"

# next/sub builds build/next/sub if its sources changed; expanding an
# empty module needs no more.
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
node next/tests/web/pages.mjs "$sites" counter rows focus fields repl || status=1
exit $status
