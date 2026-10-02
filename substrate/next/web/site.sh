#!/usr/bin/env bash
# Lifecycle: experimental.
#
# Builds a web site for one program into the directory OUT. Run it in the
# dev shell:
#
#   next/web/site.sh FILE OUT [PAGE]
#
# FILE is the program's main source file; its user interface is written
# with next/web/ui.sub and next/web/web.sub. PAGE is the HTML page to
# use; the default is host/web/page.html.
#
# The site is only static files, so any web server can serve it;
# host/web/serve.mjs is one for this machine.
#
#   OUT/index.html   the page
#   OUT/program/     the compiled program (built with next/sub)
#   OUT/host/        the JavaScript that runs the program in a browser
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ $# -lt 2 ]; then
  echo "usage: next/web/site.sh FILE OUT [PAGE]" >&2
  exit 64
fi
file="$1"
out="$2"
page="${3:-$root/host/web/page.html}"
rm -rf "${out:?}"
mkdir -p "$out/host/web"
"$root/next/sub" build "$file" -o "$out/program"
cp "$root/host/subhost-core.mjs" "$out/host/"
cp "$root/host/web/subhost-web.mjs" "$root/host/web/dom.mjs" "$root/host/web/guest.mjs" "$root/host/web/guest-worker.mjs" \
  "$out/host/web/"
cp "$page" "$out/index.html"
