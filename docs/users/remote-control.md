# Remote Control (qwen-rc)

Run `qwen-rc serve` on a workstation and pair other devices to it. The
daemon mints a single-use bootstrap code and writes it to the path shown in
its banner (the code itself is never printed); redeem it at
`https://<host>:<port>/ui/` (web viewer) or from the `qwen-rc` terminal
client. Once paired, either surface can watch, prompt, approve permissions,
and manage sessions on that daemon.

## Managing multiple daemons

`qwen-rc` tracks every daemon you work with in a registry at
`~/.qwen/rc/clients.toml` (mode 0600, written atomically). Each entry needs
a unique `name` and `url`; at most one entry may be `default`:

```toml
[[daemon]]
name = "workstation-1"
url  = "https://qwen.local:4170"
tokenStorageKey = "qwen-rc:qwen.local:4170:token"
default = true
```

Manage it with `qwen-rc daemons`:

- `add <name> <url>` — probes `GET <url>/rc/capabilities` (rejects
  non-daemon URLs), shows a trust warning — "This daemon can serve
  arbitrary JavaScript to your browser when you open its UI" (default: no) —
  and only then walks the pairing flow. Declining writes nothing. `--yes`
  skips the prompt for automation.
- `list`, `remove <name>` (revokes the daemon-side token first),
  `set-default <name>`, `health [--all]`, `whoami [--daemon <name>]`.

Every per-daemon command (`sessions`, `search`, `fork`, `share`, `tokens`,
`audit`, `bridges`) accepts `--daemon <name>` and defaults to the registry's
default daemon. An unknown name exits 1 with `daemon_unknown`; an empty
registry exits with `registry_empty` and a hint to run
`qwen-rc daemons add`.

Terminal tokens live in the OS keyring, falling back to a 0600 file under
`~/.qwen/rc/tokens/` (with a one-time
`os_keyring_unavailable_using_file_fallback` stderr warning); browser
tokens live in the daemon's own origin `localStorage`.

### Daemon switcher and health

The web viewer's **Daemons** section lists each registered daemon with a
health dot: green = `/rc/health` 200 within the last 30 s; yellow = last 200
is 30 s–5 min old, or the latest poll was 5xx; red = 401/403, unreachable,
or no success in over 5 min. Polling runs every 30 s (configurable, clamped
to a 10 s minimum) and pauses while the tab is backgrounded. Clicking a row
switches to that daemon via a full navigation to its `/ui/`.

### Aggregated views (cross-daemon fan-out)

Two views fan out across daemons in parallel; a failing daemon never blocks
the view:

- **Sessions on all daemons** — one unified list, newest first, each row
  pill-tagged with its source daemon; clicking a session opens it on the
  source daemon's `/ui/session/<id>`.
- **Search → "all daemons"** — the query fans out to every other daemon;
  each hit row is pill-tagged with its source, and a footer note records
  empty or failed daemons (`B: 0 hits`, `B: 401 not paired · re-pair to
include`).

Each failing daemon contributes exactly one status row: `RE-PAIR REQUIRED`
(401, with a link to that daemon's UI — never auto-retried with the stale
token), `OFFLINE since <time>` (last contact older than the stale window),
`ERROR — daemon returned 503`, or `UNREACHABLE — last seen 4m ago`
(network/timeout).

### Origin isolation and CORS admission

Each daemon's token is stored in that daemon's own origin, so the browser's
same-origin policy keeps daemon A's JavaScript from reading daemon B's
token. Cross-origin fan-out additionally needs CORS admission: the TARGET
daemon's allowlist must admit the source UI's origin.

Pairing alone does not do this — redemption-time admission is gated on
`Sec-Fetch-Site`, so a browser wizard can never self-admit an origin. The
supported path is owner-manual admission on the target daemon:

```bash
qwen-rc cors add https://qwen.local:4170
```

(or `POST /rc/cors { "origin": "…" }`). If a fan-out fetch fails a CORS
preflight, the UI names the missing direction and shows the exact command to
run.
