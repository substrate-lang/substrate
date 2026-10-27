#!/usr/bin/env bash
# The server against nginx and Node's own http server, each loaded by wrk: a short answer, a 16 KB page as it is and
# gzipped, and a 1 MB file. In the flake's proxies shell: nix develop .#proxies -c bench/http/run.sh [SECONDS]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/build/bench/http"
seconds="${1:-5}"
mkdir -p "$out"

(cd "$here" && "$root/bin/sub" build server.sub -o "$out/server" -c "$root/build/bench/cache" > /dev/null)
node --no-warnings "$here/run.mjs" "$out" "$seconds"
