# @qwen-code/qwen-live

Standalone Live voice daemon: a realtime voice control plane that orchestrates
Qwen Code sessions.

`qwen-live` connects three parties:

- **Qwen Live Host** (the macOS overlay app) over the Live Host WebSocket
  protocol v6 — the same wire protocol and `~/.qwen/live/daemon.json` discovery
  file the built-in `qwen serve` Live integration uses, so an already-installed
  Host binary connects without changes.
- **A DashScope realtime voice model** (`qwen-omni` realtime) that owns the
  conversation: VAD, direct answers, and a small tool surface for dispatching
  work.
- **Qwen Code sessions** through a `BackendAdaptor`. The first adaptor drives a
  running `qwen serve` daemon over its REST/SSE surface.

The live session itself is fully owned by this daemon (JSONL logs under
`~/.qwen-live/sessions/`); backend sessions are ordinary Qwen Code sessions
that keep running after a call ends.

## Run

```bash
# Requires a running `qwen serve` and a DashScope API key.
DASHSCOPE_API_KEY=sk-... qwen-live
```

Configuration comes from environment variables (`QWEN_LIVE_*`,
`DASHSCOPE_API_KEY`, `QWEN_SERVER_TOKEN`) with `~/.qwen-live/config.json` as
the file-based fallback. See `src/config.ts` for the full list.

Only one Live daemon may own the Host discovery file at a time. If the
built-in `qwen serve` Live integration is enabled and running, `qwen-live`
fails fast at startup instead of taking over.

## Host bootstrap

The Live Host installer is ported: `GET /live/setup` reports the installed
Host's state, `POST /live/setup/install` downloads, verifies (sha256 +
codesign + team identifier), and installs the latest Host release, and
`POST /live/setup/launch` opens it. macOS only (the same surface `qwen
serve` exposes). All three sit behind the daemon's Bearer token; a browser
context (Origin header) is always refused.

```bash
TOKEN=$(jq -r .token ~/.qwen/live/daemon.json)
PORT=$(jq -r .url ~/.qwen/live/daemon.json | sed 's/.*://')
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/live/setup"
```

## Status

Incubating inside the qwen-code monorepo, tracking M1+M2 (plus the M1
installer, now ported) of the Live split roadmap (issue #10118). The Host app itself, non-qwen-code adaptors (M4), and retiring
the built-in Live integration (M5) are tracked in later milestones of
issue #10118.
