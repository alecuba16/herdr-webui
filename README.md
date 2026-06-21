# Herdr WebUI

Standalone browser UI for an official Herdr backend session.

`herdr-webui` is not a Herdr fork and does not ship the Herdr terminal multiplexer. It connects to a running Herdr backend through Herdr's JSON API socket and direct terminal attach socket, then exposes workspace navigation, agent status, and terminal attach in a local web app.

## Requirements

- Rust toolchain for local builds.
- Git CLI for worktree features.
- Official Herdr binary available as `herdr` in `PATH`, or set `HERDR_WEB_HERDR_BIN`.

Compatibility:

- Backend protocol: `14`.
- Minimum tested Herdr: `0.7.0`.
- Maximum tested Herdr: `0.7.1`.
- Newer Herdr builds may work when protocol stays compatible, but WebUI reports them as untested.

## Build

```sh
make build
```

Binary output:

```text
target/release/herdr-webui
```

## Run Locally

Start Herdr separately:

```sh
herdr server
```

Run WebUI without login on loopback:

```sh
make run-web-local
```

Open:

```text
http://127.0.0.1:8787
```

Use a specific Herdr binary when WebUI launches backend sessions:

```sh
HERDR_WEB_HERDR_BIN=/opt/homebrew/bin/herdr make run-web-local
```

## CLI

```text
herdr-webui [--bind HOST:PORT] [--session NAME] [--api-socket PATH] [--client-socket PATH]
herdr-webui --version
herdr-webui install-mac [--bind HOST:PORT] [--session NAME]
herdr-webui update-mac
herdr-webui install-linux [--bind HOST:PORT] [--session NAME]
herdr-webui update-linux
herdr-webui start-mac | start
herdr-webui stop-mac | stop
herdr-webui restart-mac | restart
herdr-webui start-linux | start
herdr-webui stop-linux | stop
herdr-webui restart-linux | restart
herdr-webui uninstall-mac
herdr-webui uninstall-linux
```

## Project Layout

- `Cargo.toml`: Rust crate manifest for `herdr-webui`.
- `src/main.rs`: WebUI server, auth, JSON proxy, WebSockets, terminal bridge, install helpers.
- `src/assets.rs`: embedded frontend asset responses.
- `src/compat.rs`: backend compatibility checks.
- `src/protocol.rs`: Herdr direct terminal attach wire types and frame codec.
- `src/service.rs`: OS service helpers.
- `src/assets/`: embedded HTML/CSS/JS and frontend tests.
- `.github/workflows/webui-ci.yml`: WebUI CI.
- `.github/workflows/webui-release.yml`: WebUI release builds for `v0.0.*` tags.
- `Makefile`: local build, run, install, update, uninstall commands.

The Rust binary embeds frontend assets with `include_str!`, so release artifacts do not need external static files next to the binary.

## Authentication

Server access settings are stored in `~/.config/herdr-webui/webui-settings.json` and can be edited from WebUI Settings:

- Bind address, for example `127.0.0.1:8787` or `0.0.0.0:8787`.
- Username.
- Password.
- Localhost auth bypass.

Non-localhost binds require both username and password. WebUI rejects `0.0.0.0` or any other non-loopback bind until both credentials are configured.

## Sessions

By default, WebUI targets Herdr's default session sockets.

Use a named session:

```sh
target/release/herdr-webui --session work --bind 127.0.0.1:8787
```

When Herdr is offline, WebUI shows a session manager. It can launch Herdr using `HERDR_WEB_HERDR_BIN` or `herdr` from `PATH`, retry connection, reset workspaces, or close the current Herdr session.

If `--session NAME` is supplied, launched Herdr processes receive `HERDR_SESSION=NAME`.

## Install

Install as a per-user macOS LaunchAgent:

```sh
make install-mac
```

Install as a per-user Linux systemd service:

```sh
make install-linux
```

Release binaries can install themselves too:

```sh
./herdr-webui install-mac
./herdr-webui install-linux
```

Update installed binary and restart service:

```sh
make update-mac
make update-linux
```

Uninstall service:

```sh
make uninstall-mac
make uninstall-linux
```

## Release Policy

WebUI releases use `v0.0.x` tags and GitHub Release notes. Root Herdr releases are not produced by this repository.
