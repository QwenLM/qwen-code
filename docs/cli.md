# craft-cli

Terminal client for Craft Agent. It can connect to a running server or run a self-contained Qwen-backed session.

## Quick Start

```bash
bun run apps/cli/src/index.ts run "Hello, world!"
bun run apps/cli/src/index.ts run --workspace-dir ./project "Summarize this repo"
```

## Connection Options

| Flag | Env var | Description |
|------|---------|-------------|
| `--url <ws[s]://...>` | `CRAFT_SERVER_URL` | Server WebSocket URL |
| `--token <secret>` | `CRAFT_SERVER_TOKEN` | Authentication token |
| `--workspace <id>` | | Workspace ID |
| `--timeout <ms>` | | Request timeout |
| `--tls-ca <path>` | `CRAFT_TLS_CA` | Custom CA certificate |
| `--json` | | Raw JSON output |

## Commands

```bash
craft-cli ping
craft-cli health
craft-cli versions
craft-cli workspaces
craft-cli sessions
craft-cli connections
craft-cli sources
craft-cli session create --name "Investigation"
craft-cli session messages <session-id>
craft-cli send <session-id> "Continue"
craft-cli cancel <session-id>
craft-cli run "Self-contained prompt"
```

## Run

`craft-cli run` spawns a local headless server, creates a session, sends the prompt, streams the response, and shuts down.

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace-dir <path>` | | Register a workspace directory before running |
| `--source <slug>` | | Enable a source, repeatable |
| `--output-format <fmt>` | `text` | `text` or `stream-json` |
| `--mode <mode>` | `allow-all` | Permission mode |
| `--model <id>` | Qwen default | Model ID |
| `--provider <name>` | `qwen` | Compatibility flag; only `qwen` is used |
| `--no-cleanup` | `false` | Keep the temporary session |
| `--server-entry <path>` | | Custom server entry point |

Provider, API key, and base URL flags are accepted for script compatibility, but this product uses the built-in Qwen Code backend.

## Validate Server

```bash
craft-cli --validate-server --url ws://127.0.0.1:9100 --token <token>
craft-cli --validate-server
```

Without `--url`, validation starts a temporary local headless server.
