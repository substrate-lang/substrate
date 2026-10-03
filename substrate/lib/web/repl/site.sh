#!/usr/bin/env bash
# Lifecycle: experimental.
#
# Builds the REPL web site into the directory OUT. Run it in the dev
# shell:
#
#   lib/web/repl/site.sh OUT
#   host/web/serve.mjs OUT        # serves OUT; open the address it prints
#
# The site is made of static files, so any web server can serve it:
#
#   index.html     the page (page.html)
#   host/          the JavaScript that runs programs in a browser
#   program/       the page's program: repl.sub, the user interface
#   session.pack   the compiler program: session.sub, which the page runs
#                  in a sandboxed worker
#   files.pack     the library sources that the user's code can `require`:
#                  the C-like Lisp, Substrate, Bend, and what they need
#
# A "pack" is many files stored in one, so the page can fetch them with a
# single request (host/web/pack.mjs).
#
# files.pack must hold the same sources that session.sub was built from.
# When the user's code requires a library, the compiler recognises its
# modules by a hash of their source, and reuses the copies it is already
# running. With different sources it would load second copies, which do
# not share state with the running ones.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [ $# -lt 1 ]; then
  echo "usage: lib/web/repl/site.sh OUT" >&2
  exit 64
fi
out="$1"

# The page's program, the host and the page.
"$root/lib/web/site.sh" "$root/lib/web/repl/repl.sub" "$out" "$root/lib/web/repl/page.html"

# The compiler program, built into a temporary directory and then packed.
"$root/bin/sub" build "$root/lib/web/repl/session.sub" -o "$out/session"
"$root/host/web/pack.mjs" -o "$out/session.pack" -C "$out/session" .
rm -r "${out:?}/session"

# The library sources.
"$root/host/web/pack.mjs" -o "$out/files.pack" -C "$root" compiler/print.sub compiler/memory.sub compiler/numbers.sub compiler/kernel.sub compiler/kernel-forms.sub compiler/syntax-match.sub compiler/patterns.sub compiler/base lib/substrate lib/bend
