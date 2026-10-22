{
  description = "substrate: a thin Lisp over WebAssembly";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      chromium = pkgs:
        if pkgs.stdenv.isLinux then pkgs.chromium
        else pkgs.runCommand "chromium" {
          browsers = pkgs.playwright-driver.browsers-chromium.override { withFfmpeg = false; };
        } ''
          app="$(find -L "$browsers" -maxdepth 3 -name '*.app' | head -1)"
          [ -n "$app" ] || { echo "no application bundle in $browsers" >&2; exit 1; }
          mkdir -p "$out/bin"
          { echo '#!${pkgs.runtimeShell}'
            echo "exec \"$app/Contents/MacOS/$(basename "$app" .app)\" \"\$@\""
          } > "$out/bin/chromium"
          chmod +x "$out/bin/chromium"
        '';
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.wasm-tools    # validate / print emitted modules
            pkgs.lld           # wasm-ld: links the C benchmarks' C to wasm (bench/substrate)
            pkgs.gnumake
            pkgs.time          # GNU time: bench/bend/compile's time and memory
            pkgs.nodejs        # V8: the host (host/subhost.mjs), and the web tests' driver
            pkgs.openssl       # certificates for the TLS test
            (chromium pkgs)    # the headless browser of the web tests (above)
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.clang     # the C benchmarks' compiler (bench/substrate)
          ];
        };
      });
    };
}
