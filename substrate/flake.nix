{
  description = "substrate: a thin Lisp over WebAssembly";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.chez          # stage0 compiler host
            pkgs.wasmtime      # wasm engine (CLI, for poking at modules)
            pkgs.wasmtime.dev  # C API headers for host/subhost.c
            pkgs.wasmtime.lib  # libwasmtime.so
            pkgs.wasm-tools    # validate / print emitted modules
            pkgs.gcc
            pkgs.gnumake
          ];
          WASMTIME_INCLUDE = "${pkgs.wasmtime.dev}/include";
          WASMTIME_LIB = "${pkgs.wasmtime.lib}/lib";
        };
      });
    };
}
