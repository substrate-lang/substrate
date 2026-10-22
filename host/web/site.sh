#!/usr/bin/env bash
# Builds a web site into OUT: the program, the host, the page, and packs for guests and files.
# sub site OUT FILE [-p PAGE] [-g NAME FILE] [-f NAME PATH ...]
# FILE: a program's source, or a directory `sub build` wrote. -g builds FILE as NAME.pack, for a guest.
# -f packs the PATHs, from the repository's root, as NAME.pack.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
usage() {
  echo "usage: sub site OUT FILE [-p PAGE] [-g NAME FILE] [-f NAME PATH ...]" >&2
  exit 64
}
[ $# -ge 2 ] || usage
out="$1"
file="$2"
shift 2
page="$root/host/web/page.html"
if [ -e "$out" ] && { [ ! -d "$out" ] || { [ -n "$(ls -A "$out")" ] && [ ! -f "$out/program/program" ]; }; }; then
  echo "site: $out is not a site, so it is not replaced" >&2
  exit 1
fi
rm -rf "${out:?}"
mkdir -p "$out/host/modules" "$out/host/web"
program() {
  if [ -d "$1" ]; then cp -r "$1" "$2"; else "$root/bin/sub" build "$1" -o "$2"; fi
}
program "$file" "$out/program"
while [ $# -gt 0 ]; do
  case "$1" in
    -p)
      [ $# -ge 2 ] || usage
      page="$2"
      shift 2 ;;
    -g)
      [ $# -ge 3 ] || usage
      program "$3" "$out/$2"
      "$root/host/web/pack.mjs" -o "$out/$2.pack" -C "$out/$2" .
      rm -r "${out:?}/$2"
      shift 3 ;;
    -f)
      [ $# -ge 3 ] || usage
      name="$2"
      shift 2
      paths=()
      while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do
        paths+=("$1")
        shift
      done
      "$root/host/web/pack.mjs" -o "$out/$name.pack" -C "$root" "${paths[@]}" ;;
    *) usage ;;
  esac
done
assets="$(dirname "$file")/assets"
if [ -d "$assets" ]; then
  cp -RL "$assets" "$out/assets"
  (cd "$out" && find assets -type f | LC_ALL=C sort) > "$out/assets.list"
else
  : > "$out/assets.list"
fi
cp "$root"/host/*.mjs "$out/host/"
cp "$root"/host/modules/*.mjs "$out/host/modules/"
for f in "$root"/host/web/*.mjs; do
  case "$(basename "$f")" in pack.mjs | serve.mjs | browser.mjs) ;; *) cp "$f" "$out/host/web/" ;; esac
done
cp "$page" "$out/index.html"
