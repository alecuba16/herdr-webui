{
  lib,
  rustPlatform,
}:

let
  manifest = lib.importTOML ../webui/Cargo.toml;
in
rustPlatform.buildRustPackage {
  pname = manifest.package.name;
  version = manifest.package.version;

  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.intersection (lib.fileset.fromSource (lib.sources.cleanSource ./..)) (
      lib.fileset.unions [
        ../Cargo.lock
        ../Cargo.toml
        ../webui
      ]
    );
  };

  cargoLock = {
    lockFile = ../Cargo.lock;
  };

  cargoBuildFlags = [ "--package=herdr-webui" ];
  cargoTestFlags = [ "--package=herdr-webui" ];

  meta = {
    description = "Browser UI for an official Herdr backend session";
    homepage = "https://github.com/alecuba16/herdr-webui";
    license = lib.licenses.agpl3Plus;
    mainProgram = "herdr-webui";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
