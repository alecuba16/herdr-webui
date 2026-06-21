{
  description = "herdr-webui — browser UI for official Herdr sessions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          herdr-webui = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit herdr-webui;
          default = herdr-webui;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/herdr-webui";
          meta.description = "Run Herdr WebUI";
        };
      });

      checks = forAllSystems (system: {
        herdr-webui = self.packages.${system}.default;
        default = self.checks.${system}.herdr-webui;
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            name = "herdr-webui-dev";
            packages = with pkgs; [
              cargo
              clippy
              just
              rustc
              rustfmt
            ];
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);

      overlays.default = final: _prev: {
        herdr-webui = final.callPackage ./nix/package.nix { };
      };
    };
}
