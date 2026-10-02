#!/usr/bin/env bash
# Lifecycle: experimental. The site of the page that is a session of the
# compiler (repl.sub): its program and the host (next/web/site.sh), its
# page (page.html), and the sources a session's inputs can require, the
# languages built on the kernel, as a file pack (host/web/pack.mjs). The
# pack's sources are those the program was built from, so the modules a
# session compiles from them are the running compiler's own, by their
# hashes (next/README.md, the kernel module). In the dev shell:
#
#   next/web/repl/site.sh OUT
#   host/web/serve.mjs OUT        # then open the address it says
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [ $# -lt 1 ]; then
  echo "usage: next/web/repl/site.sh OUT" >&2
  exit 64
fi
out="$1"
"$root/next/web/site.sh" "$root/next/web/repl/repl.sub" "$out" "$root/next/web/repl/page.html"
"$root/host/web/pack.mjs" -o "$out/files.pack" -C "$root" lib/print.sub next/c next/compiler/kernel.sub \
  next/compiler/numbers.sub next/substrate next/bend
