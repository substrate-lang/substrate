#!/usr/bin/env bash
# packages/sqlite against SQLite built natively, on the SQL of speedtest1's tests (its mix but rtree and app, which a script
# cannot hold), with the database in a file and in memory. In the dev shell: nix develop -c bench/sqlite/run.sh [SIZE
# [REPS]]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/sqlite"
size="${1:-100}"
reps="${2:-1}"
mkdir -p "$out"

# packages/sqlite/build.sh's options, but with SQLite's own files
flags=(-O2 -DSQLITE_THREADSAFE=0 -DSQLITE_TEMP_STORE=2 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_LOCALTIME
       -DSQLITE_OMIT_SHARED_CACHE -DSQLITE_OMIT_DEPRECATED -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_DQS=0
       -DSQLITE_LIKE_DOESNT_MATCH_BLOBS -I"$SQLITE_AMALGAMATION")
# speedtest1, with a semicolon after each statement it writes to its script
sed 's/fprintf(g.pScript,"%s\\n",z);/fprintf(g.pScript,"%s;\\n",z);/' "$SQLITE_SPEEDTEST1" > "$out/speedtest1.c"
NIX_HARDENING_ENABLE= clang "${flags[@]}" -o "$out/speedtest1" "$out/speedtest1.c" "$SQLITE_AMALGAMATION/sqlite3.c" -lm
NIX_HARDENING_ENABLE= clang "${flags[@]}" -o "$out/native" "$here/native.c" "$SQLITE_AMALGAMATION/sqlite3.c" -lm
"$out/speedtest1" --testset main,orm/25,cte/20,json,fp/3,parsenumber/25,star --size "$size" \
  --script "$out/script.sql" :memory: > /dev/null
(cd "$here" && "$root/bin/sub" build speed.sub -o "$out/ours" -c "$root/build/bench/cache" > /dev/null)

node --experimental-wasm-exnref --no-liftoff --no-warnings "$here/run.mjs" "$out" "$reps"
