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
# Assets. If there is a directory called `assets` next to FILE, it is
# copied into the site: images, sounds, text, level data, anything. Its
# files can then be used in two ways.
#
#   - By the page, as "assets/NAME". They are ordinary files of the site,
#     so this is a URL that works wherever the browser takes one: the src
#     of an <img> in a view, a style sheet, load-image
#     (next/web/canvas.sub).
#   - By the program, as files. The page downloads the files listed in
#     assets.list before it starts the program (host/web/subhost-web.mjs,
#     the `lists` option), so the program can read "assets/NAME" with the
#     ordinary file functions (next/c/files.sub).
#
# The site is only static files, so any web server can serve it;
# host/web/serve.mjs is one for this machine.
#
#   OUT/index.html    the page
#   OUT/program/      the compiled program (built with next/sub)
#   OUT/assets/       a copy of the program's assets, if it has any
#   OUT/assets.list   the paths of those files, one per line; empty if
#                     the program has none
#   OUT/host/         the JavaScript that runs the program in a browser
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
assets="$(dirname "$file")/assets"
if [ -d "$assets" ]; then
  # -L copies the file a symbolic link points to, not the link.
  cp -RL "$assets" "$out/assets"
  (cd "$out" && find assets -type f | LC_ALL=C sort) > "$out/assets.list"
else
  : > "$out/assets.list"
fi
cp "$root/host/subhost-core.mjs" "$out/host/"
cp "$root/host/web/subhost-web.mjs" "$root/host/web/dom.mjs" "$root/host/web/audio.mjs" "$root/host/web/guest.mjs" \
  "$root/host/web/guest-worker.mjs" "$out/host/web/"
cp "$page" "$out/index.html"
