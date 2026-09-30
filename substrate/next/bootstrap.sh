#!/usr/bin/env bash
# Lifecycle: experimental. The new compiler's fixpoint, as make bootstrap
# checks the compiler's (spec 1.4): build/next/sub, which next/sub builds
# from the seed, builds its sources again, into build/next/sub-2, the same
# bytes, its program and each linklet. With seed, the build then becomes
# the seed (next/seed), as make seed makes the compiler's. In the dev
# shell:
#
#   next/bootstrap.sh [seed]
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# next/sub builds build/next/sub if its sources changed; expanding an
# empty module needs no more.
empty="build/next/empty.sub"
mkdir -p build/next
: > "$empty"
next/sub expand "$empty" > /dev/null

out=build/next/sub-2
rm -rf "${out:?}"
mkdir -p "$out"
"${HOST:-build/subhost}" "$root/build/next/sub" "$root" build next/compiler/main.sub -o "$out" -p "$root" -d "$root" \
  -r "$root/build/next/sub"
cmp -s build/next/sub/program "$out/program" || { echo "bootstrap: the program lists differ"; exit 1; }
while read -r l; do
  cmp -s "build/next/sub/$l.wasm" "$out/$l.wasm" || { echo "bootstrap: $l differs"; exit 1; }
done < build/next/sub/program
echo "bootstrap: build/next/sub builds itself"

if [ "${1:-}" = seed ]; then
  rm -rf next/seed
  mkdir next/seed
  cp build/next/sub/program build/next/sub/*.wasm next/seed/
  echo "bootstrap: build/next/sub is the seed"
fi
