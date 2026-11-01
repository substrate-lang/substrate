#!/usr/bin/env bash
# The proxy tests, Caddy and nginx in front of a server, in the flake's proxies shell:
# nix develop .#proxies -c tests/proxy/run.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$root/build/proxy"
mkdir -p "$out"

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout "$out/key.pem" -out "$out/cert.pem" 2> /dev/null
(cd "$root/tests/proxy" && "$root/bin/substrate" build server.sub -o "$out/server" -c "$root/build/tests/cache" > /dev/null)
node "$root/tests/proxy/run.mjs" "$out"
