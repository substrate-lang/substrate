#!/usr/bin/env bash
# Builds the web site of a program: lib/web/site.sh FILE OUT [PAGE].
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ $# -lt 2 ]; then
  echo "usage: lib/web/site.sh FILE OUT [PAGE]" >&2
  exit 64
fi
file="$1"
out="$2"
page="${3:-$root/host/web/page.html}"
rm -rf "${out:?}"
mkdir -p "$out/host/web" "$out/host/modules"
"$root/bin/sub" build "$file" -o "$out/program"
assets="$(dirname "$file")/assets"
if [ -d "$assets" ]; then
  cp -RL "$assets" "$out/assets"
  (cd "$out" && find assets -type f | LC_ALL=C sort) > "$out/assets.list"
else
  : > "$out/assets.list"
fi
cp "$root/host/subhost-core.mjs" "$root/host/guest-common.mjs" "$out/host/"
cp "$root"/host/modules/*.mjs "$out/host/modules/"
cp "$root/host/web/subhost-web.mjs" "$root/host/web/dom.mjs" "$root/host/web/audio.mjs" "$root/host/web/gpu.mjs" \
  "$root/host/web/guest.mjs" "$root/host/web/guest-worker.mjs" "$out/host/web/"
cp "$page" "$out/index.html"
