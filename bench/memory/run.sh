#!/usr/bin/env bash
# The server's memory for each kind of connection, and the compiler's time building itself.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/memory"
reps="${1:-3}"
mkdir -p "$out"

(cd "$here" && "$root/bin/substrate" build server.sub -o "$out/server" -c "$root/build/bench/cache" > /dev/null)
node --no-warnings "$here/run.mjs" "$out" "$reps"
