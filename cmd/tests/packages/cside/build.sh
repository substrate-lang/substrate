#!/usr/bin/env bash
# cside.wasm and unexported.wasm from cside.c and unexported.c, side modules, the second without __wasm_call_ctors
# exported, in the dev shell: nix develop -c cmd/tests/packages/cside/build.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
side() { NIX_LDFLAGS= wasm32-unknown-wasi-clang -O2 -fPIC -fvisibility=default -nostdlib -shared -Wl,--experimental-pic -Wl,--no-entry "$@"; }
side -Wl,--unresolved-symbols=import-dynamic -Wl,--export=__wasm_call_ctors -o cside.wasm cside.c
side -o unexported.wasm unexported.c
