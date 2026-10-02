{
  description = "substrate: a thin Lisp over WebAssembly";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.wasmtime      # wasm engine (CLI, for poking at modules)
            pkgs.wasmtime.dev  # C API headers for host/subhost.c
            pkgs.wasmtime.lib  # libwasmtime
            pkgs.wasm-tools    # validate / print emitted modules
            pkgs.lld           # wasm-ld: links the C benchmarks' C to wasm (examples/c/bench)
            pkgs.gnumake
            pkgs.nodejs    # V8, to compare engines (host/subhost.mjs)
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.gcc       # on macOS, the shell's clang is the C compiler
            pkgs.perf      # profile compiled wasm (SUBHOST_PERFMAP)
            pkgs.chromium  # the headless browser used by the web tests (host/web/browser.mjs)
          ];
          WASMTIME_INCLUDE = "${pkgs.wasmtime.dev}/include";
          WASMTIME_LIB = "${pkgs.wasmtime.lib}/lib";
        };
      });
    };
}
