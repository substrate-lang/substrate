#!/usr/bin/env bash
# Lifecycle: experimental. A page's site: the program of FILE, a module
# whose views are ui.sub's, built by the new compiler (next/sub), with the
# host that runs it in a page (host/web) and the page, PAGE, or
# host/web/page.html, as OUT/index.html. The site is files: any server of
# them serves it, as host/web/serve.mjs does on this machine. In the dev
# shell:
#
#   next/web/site.sh FILE OUT [PAGE]
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
cp "$root/host/web/subhost-web.mjs" "$root/host/web/dom.mjs" "$out/host/web/"
cp "$page" "$out/index.html"
