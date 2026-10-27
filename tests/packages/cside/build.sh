#!/usr/bin/env bash
# cside.wasm from cside.c, a side module, in the dev shell: nix develop -c tests/packages/cside/build.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
wasm32-unknown-wasi-clang -O2 -fPIC -fvisibility=default -nostdlib -shared -Wl,--experimental-pic -Wl,--no-entry \
  -Wl,--unresolved-symbols=import-dynamic -o cside.wasm cside.c
