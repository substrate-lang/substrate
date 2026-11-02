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
      devShells = forAll (pkgs: rec {
        # tests/proxy and bench/http: Caddy and nginx, and wrk to load a server, apart from the default shell
        proxies = pkgs.mkShell {
          inputsFrom = [ default ];
          packages = [ pkgs.caddy pkgs.nginx pkgs.wrk ];
        };
        # bench/compress: the Silesia corpus, apart from the default shell
        silesia = default.overrideAttrs (_: {
          SILESIA = pkgs.fetchzip {
            url = "https://sun.aei.polsl.pl/~sdeor/corpus/silesia.zip";
            stripRoot = false;
            hash = "sha256-RZsvB/b9XyZEc523xvpGtPA7/mYL99E9X6JgE/D3fvA=";
          };
        });
        default = pkgs.mkShell {
          packages = [
            pkgs.wasm-tools    # validate / print emitted modules
            pkgs.lld           # wasm-ld: links the C benchmarks' C to wasm (bench/substrate)
            pkgs.gnumake
            pkgs.time          # GNU time: bench/bend/compile's time and memory
            pkgs.nodejs        # V8: the host (substrate/host/subhost.mjs), and the web tests' driver
            pkgs.openssl       # certificates for the proxy tests
            pkgs.git           # repositories for the package tests
            pkgs.gh            # GitHub: the CI runs
            (chromium pkgs)    # the headless browser of the web tests (above)
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.clang     # the C benchmarks' compiler (bench/substrate)
            pkgs.pkgsCross.wasi32.stdenv.cc   # clang for wasm with a C library: cJSON (bench/json)
          ];
          # substrate test: on Linux, Chromium's software GPU, the one on which headless Chromium draws WebGPU canvases
          SUBSTRATE_CHROMIUM_ARGS = pkgs.lib.optionalString pkgs.stdenv.isLinux
            "--enable-unsafe-swiftshader --enable-features=Vulkan --use-vulkan=swiftshader --use-angle=vulkan";
          # bench/json: cJSON's source, and nativejson-benchmark's three files
          CJSON_SOURCE = pkgs.cjson.src;
          # bench/crypto: mbedTLS's source
          MBEDTLS_SOURCE = pkgs.mbedtls.src;
          # bench/compress: zlib's source
          ZLIB_SOURCE = pkgs.zlib.src;
          # packages/sqlite/build.sh and bench/sqlite: SQLite's amalgamation, and its speedtest1.c
          SQLITE_AMALGAMATION = pkgs.fetchzip {
            url = "https://sqlite.org/2026/sqlite-amalgamation-3510200.zip";
            hash = "sha256-WUH/22OMthEsDTGrpZ8dLCts6890wSLGMmPWt725Gss=";
          };
          SQLITE_SPEEDTEST1 = pkgs.fetchurl {
            url = "https://raw.githubusercontent.com/sqlite/sqlite/version-3.51.2/test/speedtest1.c";
            hash = "sha256-ter0u8uzIP2Os/PmxM1fUaZN0M1w7+lpY00XheNBlnU=";
          };
          JSON_BENCH_FILES = pkgs.linkFarm "json-bench-files" (map (f: {
            name = "${f.name}.json";
            path = pkgs.fetchurl {
              url = "https://raw.githubusercontent.com/miloyip/nativejson-benchmark/478d5727c2a4048e835a29c65adecc7d795360d5/data/${f.name}.json";
              inherit (f) hash;
            };
          }) [
            { name = "canada"; hash = "sha256-+Ds7NUAw1d1YdAxorE/s72TLcwoNEqkDYqfyMHf1DXg="; }
            { name = "citm_catalog"; hash = "sha256-pz56iD9uqN4RPf9ZcCl15gEZtLWNRR1RipKfMckuIFk="; }
            { name = "twitter"; hash = "sha256-oIt2nzK5X0JsvDq6/OxlwaGdPrVE1N3zIOrhQsme/F0="; }
          ]);
          # tests/encoding/json-suite.sub: JSONTestSuite
          JSON_TEST_SUITE = pkgs.fetchFromGitHub {
            owner = "nst";
            repo = "JSONTestSuite";
            rev = "1ef36fa01286573e846ac449e8683f8833c5b26a";
            hash = "sha256-s2yMgVWq2DwibAjOvLKhGDbEwXm4yke/g4mp7u565H4=";
          };
        };
      });
    };
}
