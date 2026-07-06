# Installing local-runtime-helper

`local-runtime-helper` is a small daemon that connects this machine to the
OpenMacaw runtime relay over outbound WSS. It lets OpenMacaw dispatch work to
local tools such as OpenAI-compatible model servers and OpenClaw without
opening inbound ports on the user's network.

## Build From Source

Requires Go 1.23+. From the `local-runtime-helper/` directory of the
OpenMacaw repository:

```sh
go build -o ~/.local/bin/local-runtime-helper ./cmd/local-runtime-helper
local-runtime-helper version
```

If `~/.local/bin` is not on your `PATH`, either add it to your shell profile
or run the installed binary by absolute path.

## Install From Release

No Go toolchain or repository clone needed. `install.sh` downloads the
matching archive for macOS or Linux (arm64/amd64), verifies it against the
release's `checksums.txt`, and writes the binary to
`~/.local/bin/local-runtime-helper`:

```sh
curl -fsSL https://raw.githubusercontent.com/kmgrassi/openmacaw/main/local-runtime-helper/install.sh | sh
```

To pin a release, set `LOCAL_RUNTIME_HELPER_VERSION=v<version>` (or pass
`--version v<version>` when running the script locally). Releases are
published by the repository's `release-local-runtime-helper` workflow when a
`v*` tag is pushed.

## Configure

Registering this machine will eventually be handled by:

```sh
local-runtime-helper register --workspace=<workspace-id> --token=<one-time-token>
```

Until that command is wired to the cloud registration API, create
`~/.config/openmacaw/runtime.toml` from `docs/runtime.toml.example` and keep
it readable only by your user:

```sh
mkdir -p ~/.config/openmacaw
cp docs/runtime.toml.example ~/.config/openmacaw/runtime.toml
chmod 0600 ~/.config/openmacaw/runtime.toml
```

Set `[cloud].endpoint` to the OpenMacaw relay WSS endpoint and `[cloud].token`
to the local runtime token issued from the dashboard. Do not commit this file.

For Ollama, LM Studio, vLLM, or another OpenAI-compatible local server, configure
the runner table like this:

```toml
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key = "ollama"
model = "qwen2.5-coder:latest"
```

## Check Setup

Use `status` for a non-network summary:

```sh
local-runtime-helper status
```

Use `doctor` before starting the daemon:

```sh
local-runtime-helper doctor
```

`doctor` checks that the config can be read, required fields are present, the
cloud relay host accepts TCP connections, runner endpoints are reachable, and an
OpenAI-compatible runner responds to `/v1/models` when configured.

## Start Manually

```sh
local-runtime-helper start
```

The daemon connects to the configured relay endpoint, registers its runners,
and stays connected until stopped. For local development against a stack
started with `./openmacaw run`, use the checked-in dev config instead:

```sh
go run ./cmd/local-runtime-helper start --config ./dev-runtime.toml --log-level debug
```

## Localhost API Origin Allowlist

`local-runtime-helper` exposes a localhost browser API on `127.0.0.1:7317` for
native directory picking. It now defaults that API to localhost web origins
only:

- `http://localhost:5173`
- `http://127.0.0.1:5173`

If you need the hosted app to reach the helper from `https://app.openmacaw.ai`,
set an explicit allowlist before launching the daemon:

```sh
export OPENMACAW_LOCAL_API_ALLOWED_ORIGINS="https://app.openmacaw.ai"
```

Use a comma-separated list if you need both hosted and local development
origins. Avoid broad allowlists; any allowed origin can trigger local helper
browser actions.

If you run the helper with the `launchd` setup below, a shell `export` is not
inherited by the background service. Add the variable to the generated plist's
`EnvironmentVariables` block before bootstrapping it:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>HOME</key>
  <string>/Users/__USER__</string>
  <key>OPENMACAW_LOCAL_API_ALLOWED_ORIGINS</key>
  <string>https://app.openmacaw.ai</string>
</dict>
```

## Run With launchd On macOS

Copy the launchd template and replace `__USER__` plus the binary path if needed:

```sh
mkdir -p ~/Library/LaunchAgents
sed "s/__USER__/$USER/g" docs/launchd/com.openmacaw.local-runtime-helper.plist \
  > ~/Library/LaunchAgents/com.openmacaw.local-runtime-helper.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.openmacaw.local-runtime-helper.plist
launchctl enable "gui/$(id -u)/com.openmacaw.local-runtime-helper"
launchctl kickstart -k "gui/$(id -u)/com.openmacaw.local-runtime-helper"
```

Inspect service state with:

```sh
launchctl print "gui/$(id -u)/com.openmacaw.local-runtime-helper"
```

Stop and remove it with:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.openmacaw.local-runtime-helper.plist
rm ~/Library/LaunchAgents/com.openmacaw.local-runtime-helper.plist
```

## Logout And Token Revocation

```sh
local-runtime-helper logout
```

This prints the local config path and the revoke steps. Revoke the machine's
local runtime token from the OpenMacaw dashboard, then remove or replace the
token in `~/.config/openmacaw/runtime.toml`. Local file cleanup is not enough
by itself; cloud-side revocation is what prevents future relay connections
with that token.
