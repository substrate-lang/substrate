#!/usr/bin/env bash
# Builds the npm package substrate-lang in build/npm, and packs it as build/substrate-lang-VERSION.tgz.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
version="$(cat substrate/VERSION)"
bin/substrate version > /dev/null
bin/bootstrap > /dev/null
rm -rf build/npm
mkdir -p build/npm/bin build/npm/build/compiler build/npm/build/sub
for p in compiler sub; do cp "build/$p/program" build/$p/*.wasm "build/npm/build/$p/"; done
git ls-files -z substrate std ':!std/tests' | tar --null -T - -cf - | tar -xf - -C build/npm
cp npm/substrate.mjs build/npm/bin/substrate.mjs
cp npm/README.md LICENSE build/npm/
node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
         process.stdout.write(JSON.stringify({ name: p.name, version: process.argv[2], ...p }, null, 2) + "\n");' \
  npm/package.json "$version" > build/npm/package.json
(cd build/npm && npm pack --silent --pack-destination .. > /dev/null)
echo "build/substrate-lang-$version.tgz"
