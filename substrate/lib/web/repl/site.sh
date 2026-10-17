#!/usr/bin/env bash
# Builds the REPL's web site into OUT: lib/web/repl/site.sh OUT.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [ $# -lt 1 ]; then
  echo "usage: lib/web/repl/site.sh OUT" >&2
  exit 64
fi
out="$1"

"$root/lib/web/site.sh" "$root/lib/web/repl/repl.sub" "$out" "$root/lib/web/repl/page.html"

"$root/bin/sub" build "$root/lib/web/repl/session.sub" -o "$out/session"
"$root/host/web/pack.mjs" -o "$out/session.pack" -C "$out/session" .
rm -r "${out:?}/session"

# files.pack must hold the sources session.sub was built from: the compiler reuses the
# modules it runs only for sources with the same hash.
"$root/host/web/pack.mjs" -o "$out/files.pack" -C "$root" compiler/print.sub compiler/memory.sub compiler/numbers.sub compiler/kernel.sub compiler/kernel-forms.sub compiler/syntax-match.sub compiler/patterns.sub compiler/base lib/substrate lib/bend
