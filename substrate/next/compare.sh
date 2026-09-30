#!/usr/bin/env bash
# Lifecycle: experimental. The new compiler (next/sub) against the
# compiler (bin/sub): each .sub file of the repository, or each FILE,
# expanded or built by both, which must give the same: for expand, its
# fully expanded code or its error; for build, its messages, and the
# program, each linklet byte for byte. A file that needs what the new
# compiler does not do yet, which it says, is counted apart. Prints each
# file that differs, then the counts. In the dev shell:
#
#   next/compare.sh expand|build [FILE ...]
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"
case "$mode" in expand|build) shift ;; *) echo "usage: next/compare.sh expand|build [FILE ...]" >&2; exit 64 ;; esac
out="$root/build/next/compare/$mode"
mkdir -p "$out"
cd "$root"
files=("$@")
[ ${#files[@]} -gt 0 ] || files=($(find compiler lib examples tests -name '*.sub' | sort))

# The programs in directories $1 and $2 are the same: their lists of
# linklets, and each linklet.
same_program() {
  [ -f "$1/program" ] && [ -f "$2/program" ] || return 1
  cmp -s "$1/program" "$2/program" || return 1
  while read -r l; do cmp -s "$1/$l.wasm" "$2/$l.wasm" || return 1; done < "$1/program"
}

same=0
later=0
differ=0
# The compiler runs with an empty cache: a module loaded from the cache
# prints nothing while compiling, as a module compiled prints what its
# compile-time code prints.
cache="$out/cache"
for f in "${files[@]}"; do
  n="${f//\//_}"
  new="$out/$n.new" old="$out/$n.old"
  if [ "$mode" = expand ]; then
    HOST=build/subhost next/sub expand "$f" > "$new.txt" 2>&1
  else
    rm -rf "${old:?}" "${new:?}"
    HOST=build/subhost next/sub build "$f" -o "$new" > "$new.txt" 2>&1
  fi
  if grep -qs "not yet in the new compiler" "$new.txt"; then
    later=$((later + 1))
    continue
  fi
  rm -rf "${cache:?}"
  if [ "$mode" = expand ]; then
    bin/sub expand "$f" -c "$cache" > "$old.txt" 2>&1
    result=$(cmp -s "$old.txt" "$new.txt" && echo same)
  else
    bin/sub build "$f" -o "$old" -c "$cache" > "$old.txt" 2>&1
    result=$(cmp -s "$old.txt" "$new.txt" && { [ -f "$old/program" ] || [ ! -f "$new/program" ]; } &&
             { [ ! -f "$old/program" ] || same_program "$old" "$new"; } && echo same)
  fi
  if [ "$result" = same ]; then
    same=$((same + 1))
  else
    differ=$((differ + 1))
    echo "differs: $f"
  fi
done
echo "$same the same, $later needing what comes later, $differ different"
