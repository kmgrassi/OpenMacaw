# local-runtime-helper

A small Go daemon that bridges a user's machine to the OpenMacaw
runtime orchestrator. Lets the orchestrator dispatch work to local
tools (OpenClaw, OpenAI-compatible model endpoints, video
editors, browser automation, etc.) without exposing the user's
machine to inbound traffic.

The cloud connects **out** to nothing; the daemon connects **out**
to the cloud over WSS. NAT-friendly, multiplexed, single
persistent connection.

## Layout

```
cmd/local-runtime-helper/   entrypoint — register / start / status / doctor / logout / version
internal/config/            ~/.config/openmacaw/runtime.toml parser
internal/relay/             persistent WSS client + reconnect loop
internal/protocol/          wire-protocol frame types (mirrors the runtime)
internal/runner/            runner adapter interface
internal/runner/<each>/     per-tool implementations
docs/runtime.toml.example   example config
docs/install.md             install and setup instructions
```

## Building from source

Requires Go 1.23+. From this directory:

```sh
go build -o ~/.local/bin/local-runtime-helper ./cmd/local-runtime-helper
local-runtime-helper version
```

Validate changes with:

```sh
go build ./...
go vet ./...
go test ./...
```

## Installing from a release

No Go toolchain or repository clone needed — the installer downloads the
latest release binary for macOS or Linux (amd64/arm64), verifies it against
the release's `checksums.txt`, and writes it to
`~/.local/bin/local-runtime-helper`:

```sh
curl -fsSL https://raw.githubusercontent.com/kmgrassi/openmacaw/main/local-runtime-helper/install.sh | sh
```

To pin a release, pass `--version v<version>` (or set
`LOCAL_RUNTIME_HELPER_VERSION`). Releases are published by the
[release workflow](../.github/workflows/release-local-runtime-helper.yml)
whenever a `v*` tag is pushed. See [docs/install.md](docs/install.md) for
configuration and launchd setup.

## Configuring runners

Each `[runner.<kind>]` table in `runtime.toml` registers one local tool this
helper will advertise to the cloud relay. The helper only advertises runners
it can actually serve, so adding a stanza both enables the runner *and*
tells the cloud the matching `runner_kind` is available.

Today the helper ships two adapters:

```toml
# OpenAI-compatible chat-completion endpoint (Ollama, llama.cpp, vLLM, ...).
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key  = "ollama"
model    = "qwen2.5-coder:latest"

# Local OpenClaw HTTP server. Advertises runner_kind = "openclaw".
[runner.openclaw]
endpoint = "http://127.0.0.1:7100"
# api_key = "optional-bearer-token"
```

Either block, both, or any future runner kind can be present — the helper
fails fast if zero runners are configured. See
[docs/runtime.toml.example](docs/runtime.toml.example) for the full annotated
example.

## Local development against the full stack

Start the core stack from the repository root (`./openmacaw run`), make sure
a local model server such as Ollama is running, then start the helper with
the checked-in dev config:

```sh
go run ./cmd/local-runtime-helper start --config ./dev-runtime.toml --log-level debug
```

## Localhost Browser API Hardening

The helper also exposes a localhost-only browser API on `127.0.0.1:7317` for
native directory picking. By default it only allows browser origins from local
development:

- `http://localhost:5173`
- `http://127.0.0.1:5173`

If you intentionally want the hosted OpenMacaw app to call this localhost API,
set an explicit allowlist before starting the helper:

```sh
export OPENMACAW_LOCAL_API_ALLOWED_ORIGINS="https://app.openmacaw.ai"
```

Use a comma-separated list if you need both hosted and local development
origins. Keep the list narrow because any allowed origin can trigger native
local-machine helper actions. Requests without an `Origin` header are rejected,
and browser POSTs must send `Content-Type: application/json`.

## Wire protocol

The cloud-side spec lives in
[`runtime/apps/orchestrator/docs/local-relay-protocol.md`](../runtime/apps/orchestrator/docs/local-relay-protocol.md).
The Go types in `internal/protocol/` mirror that spec.
