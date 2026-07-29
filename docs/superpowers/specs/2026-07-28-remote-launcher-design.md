# Design — remote-control launcher (`qwen-rc up` / `down` / `status`)

**Goal:** One command to bring the whole remote-control stack up (and down)
on a Windows+WSL2 laptop, so the operator can drive qwen-code from a phone
over Tailscale — no hand-run flags, no reading a bootstrap hint off the
laptop's tty.

**Scope (this spec — "Spec 1", the engine):** the `qwen-rc up`/`down`/
`status` orchestrator, entirely inside `packages/rc-gateway/` — **no core
changes** (it only _invokes_ the existing `qwen serve` daemon + `qwen-rc
serve` gateway). Delivers a headless, one-command bring-up + connect QR that
is useful on its own.

**Out of scope (its own later spec — "Spec 2"):** a Windows Electron
control-panel app that _drives_ this orchestrator via `wsl.exe -- qwen-rc …`
(Start/Stop, status, logs, QR, Lovelace-endpoint config). It needs this
engine first, so this is a prerequisite, not a detour.

## Topology (decided)

- **WSL2 hosts everything server-side:** `tailscaled` as its **own tailnet
  node** (its own `<host>.ts.net` name + `100.x` IP), the qwen-code daemon
  (`qwen serve`, configured to reach the models on the Lovelace workstation),
  and the rc-gateway (`qwen-rc serve`, TLS-terminated with a `tailscale
cert`, bound to the WSL Tailscale IP).
- **Windows host** later runs the Electron panel, which drives WSL via
  `wsl.exe`. Not part of this spec.
- **Phone** (on the tailnet) → `https://<host>.ts.net:<port>/ui/`, pairs
  once, controls qwen-code.

Running Tailscale _inside_ WSL (rather than reusing the Windows-host
Tailscale + mirrored networking) was chosen for robustness: it sidesteps all
host↔WSL routing and cross-boundary cert-handoff questions — the tailnet
node, the cert, and the gateway all live in one place.

## What already exists (reused unchanged)

- `qwen-rc serve` already supports **plain / native-TLS / ACME** bind modes
  (`--tls-cert`/`--tls-key` for native TLS), **spawns the `qwen serve`
  daemon** itself (or attaches to a running one), and writes the owner
  **pairing bootstrap** code. The orchestrator does not reimplement any of
  this — it composes `qwen-rc serve` with the right flags.
- systemd **is running** in this WSL, so the gateway can be managed as a
  systemd unit that survives the short-lived `wsl.exe` sessions the Electron
  app will use.

## `qwen-rc up` (idempotent)

1. **Ensure the tailnet is up.** Run `tailscale up`.
   - First run / re-auth: `tailscale up` prints an **auth URL** — the
     orchestrator surfaces it prominently (and polls `tailscale status`
     until the node is `Running`, then continues). This is the one-time
     browser authorization.
   - Already authorized: `tailscale up` is a non-interactive no-op that just
     ensures connectivity.
   - `tailscaled` not installed → clear one-time prerequisite error ("install
     tailscale in WSL"). Needs elevation → hint `tailscale set
--operator=$USER` (one-time) so `up` runs without sudo thereafter.
2. **Read node identity** from `tailscale status --json`: the `<host>.ts.net`
   MagicDNS name and the `100.x` IP.
3. **Ensure TLS.** `tailscale cert <host>.ts.net` → cert/key into
   `~/.qwen/rc/tls/` (skip if a valid, unexpired pair already exists; renew
   when near expiry). If it fails, surface the **"enable HTTPS/MagicDNS in
   the tailnet admin console"** hint — the one tailnet-side prerequisite.
4. **Start the stack.** Launch `qwen-rc serve --bind tls --tls-cert … --tls-key
… --host <ts-ip> --port <port>` as a **systemd transient unit**
   (`systemd-run --user --unit=qwen-rc-gateway …`) so it outlives the
   `wsl.exe` invocation and the whole cgroup (gateway + the `qwen serve`
   daemon it spawns) stops together on `down`. Record the unit name + params
   to `~/.qwen/rc/launcher-state.json`.
5. **Surface connect info.** Compute `https://<host>.ts.net:<port>/ui/`, read
   the gateway's owner-bootstrap code, render a **terminal QR** of the
   connect URL, and — to the human-readable output only — print URL +
   pairing code + QR. Also emit machine-readable **`--json`** (`{ status,
url, host, port, unit, certExpiry }`) for the Electron app to consume.
   The `--json` surface deliberately OMITS the owner pairing code (a
   one-time credential must not enter a machine-captured stream — the app
   reads the 0600 `owner-bootstrap.code` file itself if it needs it).

## `qwen-rc down`

Stop the recorded systemd transient unit (`systemctl --user stop
qwen-rc-gateway`), which tears down the gateway and its child daemon
together; clear the state file. Idempotent (already-stopped → success).
Leaves `tailscaled` up (it's shared infrastructure; not ours to stop).

## `qwen-rc status`

Report running/stopped, the connect URL, cert expiry, and the unit/pids —
human-readable and `--json`. Reads `~/.qwen/rc/launcher-state.json` +
`systemctl --user is-active`.

## Components (all new, in `packages/rc-gateway/src/launcher/`)

- `tailscale.ts` — wrap `tailscale up` / `status --json` / `cert`; parse the
  node name + IP; classify outcomes (running / needs-auth (+URL) /
  not-installed / needs-operator / https-not-enabled).
- `cert.ts` — resolve/refresh the `tailscale cert` pair under `~/.qwen/rc/tls/`;
  expiry check.
- `process.ts` — start/stop/status the gateway via `systemd-run --user` /
  `systemctl --user`; the state file (`state.ts`).
- `qr.ts` — render a URL as a terminal QR (small dep such as
  `qrcode-terminal`, or an existing one if present).
- `orchestrator.ts` — the `up`/`down`/`status` flows composing the above,
  returning a structured result the CLI renders as text or `--json`.
- `cli.ts` — three new top-level subcommands (`up`/`down`/`status`) dispatched
  like the existing `serve`/`daemons discover` branches.

Each unit talks to the outside world through a small **injected exec
boundary** (a `runCommand(argv): {code, stdout, stderr}` seam), so the flows
are unit-testable with stubbed `tailscale`/`systemctl`/gateway responses —
the same way the gateway tests stub the daemon. The real Tailscale + systemd
calls are the integration seam, validated with a thin end-to-end test that
stubs that boundary.

## Error handling

| Condition                          | Behavior                                                                |
| ---------------------------------- | ----------------------------------------------------------------------- |
| tailnet needs first-time auth      | Print the `tailscale up` auth URL; poll until `Running`, then continue  |
| `tailscaled` not installed         | Fail with a one-time "install tailscale in WSL" hint                    |
| `tailscale up` needs elevation     | Fail with the `tailscale set --operator=$USER` hint                     |
| `tailscale cert` fails (HTTPS off) | Fail with the "enable HTTPS/MagicDNS in the tailnet admin console" hint |
| gateway unit fails to start        | Report the `systemd-run`/gateway stderr; leave no half-state            |
| `up` when already running          | Idempotent — re-print the connect info, don't double-start              |
| `down` when already stopped        | Idempotent success                                                      |

## Security

- Confined to `packages/rc-gateway/`; no core/daemon changes; the orchestrator
  only _invokes_ existing binaries and local `tailscale`/`systemctl`.
- Adds **no new network surface** — the gateway's own auth (pairing tokens,
  scopes) and bind security are unchanged. The orchestrator's contribution is
  TLS material (via `tailscale cert`) and a bind address (the WSL Tailscale
  IP).
- The pairing bootstrap code is read from the gateway's existing owner-only
  file and shown locally (terminal/QR) — never transmitted.
- `--json` output carries only connect metadata (URL, host, port, unit,
  cert expiry) + the bootstrap code the operator already sees — no session or
  tool content.

## Prerequisites (one-time, operator-side; documented, not automated)

1. Install Tailscale inside WSL (`tailscaled` under systemd).
2. Enable **HTTPS / MagicDNS** in the tailnet admin console (required for
   `tailscale cert`).
3. `loginctl enable-linger $USER` so the user systemd instance (and the
   gateway unit) persists across the short `wsl.exe` sessions the Electron
   app uses.
4. First `qwen-rc up` triggers the one-time `tailscale up` browser auth.

## Spec artifacts (qwen-code-remote)

Ships as OpenSpec change `add-remote-launcher` (proposal, design, tasks,
`specs/remote-launcher/spec.md` — ADDED requirements for the `up`/`down`/
`status` lifecycle, the Tailscale-node + cert bring-up, and the connect-info/
QR/JSON surfacing, each with scenarios). CLI tooling is an established
OpenSpec surface here (precedent: `add-mdns-discovery`'s `daemons discover`).
No new gateway protocol/API, SSE event, notification kind, or audit action.

## Out of scope / follow-ups

- **Spec 2 — the Electron control panel** (Windows-side, new package).
- **systemd auto-start on login** (a persistent unit) — you chose the app
  over auto-start; manual up/down is the target.
- **Lovelace model-endpoint config** — that's qwen-code's own settings; the
  Electron app's config screen can manage it later. The orchestrator assumes
  qwen-code is already configured.

## Implementation phasing (fork, `packages/rc-gateway`)

- **B — Tailscale + cert layer.** `launcher/tailscale.ts` + `cert.ts` over the
  injected exec seam; unit tests for status/auth-URL/cert parsing + outcome
  classification.
- **C — process + state + orchestrator.** `launcher/{process,state,qr,
orchestrator}.ts`; the `up`/`down`/`status` flows; unit tests with a stubbed
  exec boundary (running / needs-auth / https-off / already-running paths).
- **D — CLI wiring + end-to-end.** The `up`/`down`/`status` subcommands in
  `cli.ts` (text + `--json`); a thin e2e test stubbing the exec boundary that
  drives `up` → `status` → `down`.
