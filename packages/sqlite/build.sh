#!/usr/bin/env bash
# sqlite3.wasm, a side module, from SQLite's amalgamation, os.c and the C library's string functions, in the dev
# shell: nix develop -c packages/sqlite/build.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pieces="$root/build/sqlite-libc"
mkdir -p "$pieces"
(cd "$pieces" && wasm32-unknown-wasi-ar x "$(wasm32-unknown-wasi-clang -print-file-name=libc.a)" \
  memchr.o memcmp.o memrchr.o strchr.o strchrnul.o strcmp.o strcspn.o strlen.o strncmp.o strrchr.o strspn.o)
cd "$root/packages/sqlite"
wasm32-unknown-wasi-clang -O2 -fPIC -fvisibility=default -nostdlib -shared -Wl,--experimental-pic -Wl,--no-entry \
  -Wl,--unresolved-symbols=import-dynamic \
  -DSQLITE_OS_OTHER=1 -DSQLITE_THREADSAFE=0 -DSQLITE_TEMP_STORE=2 -DSQLITE_OMIT_LOAD_EXTENSION \
  -DSQLITE_OMIT_LOCALTIME -DSQLITE_OMIT_SHARED_CACHE -DSQLITE_OMIT_DEPRECATED -DSQLITE_DEFAULT_MEMSTATUS=0 \
  -DSQLITE_DQS=0 -DSQLITE_LIKE_DOESNT_MATCH_BLOBS \
  -I"$SQLITE_AMALGAMATION" -o sqlite3.wasm "$SQLITE_AMALGAMATION/sqlite3.c" os.c "$pieces"/*.o
