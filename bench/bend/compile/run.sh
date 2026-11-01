#!/usr/bin/env bash
# Times checking and compiling the module proofs.sh writes.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
n="${1:-3200}"
out="$root/build/bench/bend"
mkdir -p "$out"
{ printf '(package proofs (version "0.1.0") (dependencies (bend (path "%s"))))\n' "$root/packages/bend"
  "$here/proofs.sh" "$n"; } > "$out/proofs-$n.sub"
cache="$out/cache"
mkdir -p "$cache"
(cd "$here" && "$root/bin/substrate" build warm.sub -o "$out/warm" -c "$cache" > /dev/null)
rm -rf "$out/proofs-$n"
log="$out/time.log"
(cd "$out" && command time -f '%e %M' "$root/bin/substrate" build "proofs-$n.sub" -o "$out/proofs-$n" -c "$cache" > "$log" 2>&1) || { cat "$log"; exit 1; }
read -r real kb < <(tail -1 "$log")
printf "proofs-%s %6s s  %5s MB\n" "$n" "$real" "$((kb / 1024))"
