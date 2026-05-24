# Local launch templates for `qwen serve` (v0.16-alpha)

Reference templates for running `qwen serve` as a long-lived background process on a developer workstation. Pairs with the [v0.16-alpha known limits](./qwen-serve.md#v016-alpha-known-limits) — local-only, single-user, BYO bearer token. Containerized / multi-host / TLS-fronted deployments defer to v0.16.x.

> **Audience**: dogfooding developers who want the daemon up across reboots, with logs going somewhere durable, and a clean `restart-on-failure` story. If you only need the daemon for the duration of a single shell session, plain `qwen serve` (foreground, Ctrl-C to stop) is fine.

## Generate a bearer token (once)

```bash
openssl rand -hex 32 > ~/.qwen-serve-token  # user-managed, NOT a built-in path
chmod 600 ~/.qwen-serve-token
export QWEN_SERVER_TOKEN="$(cat ~/.qwen-serve-token)"
```

The path / filename is yours to choose; v0.16-alpha does not auto-generate or auto-locate a token file (deferred to v0.16.x). See the [Authentication](./qwen-serve.md#authentication) section of the user guide for the canonical BYO setup.

> **Scope this `export` to the current shell session only.** Don't add it to `~/.bashrc` / `~/.zshrc` — a profile-level export exposes the bearer token to every process spawned from that shell (IDE subprocesses, browser debuggers, `npm` scripts from unrelated projects). For long-running setups, use the systemd `EnvironmentFile=` / launchd `EnvironmentVariables` mechanisms below — both scope the token to just the daemon process.

The daemon reads the bearer token from either `--token <value>` on the CLI or the `QWEN_SERVER_TOKEN` env var (whitespace stripped from both). The TypeScript SDK's `DaemonClient` constructor falls back to `QWEN_SERVER_TOKEN` when no `token` option is passed (PR 27 fallback — clients with the env var set never need to thread the value through their script).

One shell-level `export` covers both server boot and SDK client construction (just keep it scoped to the session, per the note above).

## Linux: systemd user unit

> **Find your `qwen` binary first.** The unit file's `ExecStart=` must hold an **absolute path** — service managers don't read your shell's `PATH`. Run `which qwen` to discover it. Common locations: `/usr/local/bin/qwen` (Linuxbrew, manual installs), `~/.nvm/versions/node/vX.Y.Z/bin/qwen` (nvm), `~/.fnm/aliases/default/bin/qwen` (fnm), `~/.volta/bin/qwen` (Volta). Substitute the actual path everywhere the templates below show `/PATH/TO/qwen`.

`~/.config/systemd/user/qwen-serve.service`:

```ini
[Unit]
Description=Qwen Code daemon (loopback HTTP + SSE)
After=network.target

[Service]
Type=simple
# Replace with your project; %h expands to $HOME under user units.
WorkingDirectory=%h/your-project
# Run `which qwen` to find the absolute path. systemd does NOT read $PATH.
ExecStart=/PATH/TO/qwen serve --hostname 127.0.0.1 --port 4170
# Read the bearer token from a chmod 600 file rather than inlining it
# in the unit. `Environment=` would expose the token in the unit file
# (typically 644 = world-readable). EnvironmentFile keeps the token in
# the user-owned secret file you already created with `chmod 600`.
EnvironmentFile=%h/.qwen-serve-token-env
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Build the env file once (the token file from the setup step holds the raw value; this wraps it in `KEY=value` form so systemd reads it as an env assignment):

```bash
echo "QWEN_SERVER_TOKEN=$(cat ~/.qwen-serve-token)" > ~/.qwen-serve-token-env
chmod 600 ~/.qwen-serve-token-env
```

Manage:

```bash
systemctl --user daemon-reload
systemctl --user enable --now qwen-serve.service
loginctl enable-linger "$(whoami)"               # keep the user manager running after logout / across reboot
journalctl --user -u qwen-serve -f               # tail logs
systemctl --user restart qwen-serve.service     # after token rotation
systemctl --user disable --now qwen-serve.service
```

Without `loginctl enable-linger`, the user-level systemd instance shuts down when the user logs out and only restarts on next login — on a headless dev box the daemon would not survive an SSH session ending. `enable-linger` is what makes "across reboots" actually work.

**System-wide alternative** (shared dev hosts, less common): drop the unit at `/etc/systemd/system/qwen-serve@.service` with `User=%i`, manage via `sudo systemctl enable --now qwen-serve@<username>.service`. Same `[Service]` body otherwise — but world-readable `Environment=` exposure is even more problematic at this level, so always use `EnvironmentFile=` pointing at the user's `chmod 600` file. Pick user-level + linger for single-user workstations.

## macOS: launchd user agent

> **Find your `qwen` binary first.** Same constraint as systemd — `ProgramArguments` must hold an **absolute path**. Run `which qwen` to discover it. Common locations on macOS: `/opt/homebrew/bin/qwen` (Homebrew on Apple Silicon), `/usr/local/bin/qwen` (Homebrew on Intel, manual installs), `~/.nvm/versions/node/vX.Y.Z/bin/qwen` (nvm), `~/.volta/bin/qwen` (Volta). Substitute below where the template shows `/PATH/TO/qwen`.

`~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.qwenlm.qwen-serve</string>
  <key>ProgramArguments</key>
  <array>
    <!-- Run `which qwen` to find the absolute path; launchd does NOT read $PATH. -->
    <string>/PATH/TO/qwen</string>
    <string>serve</string>
    <string>--hostname</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>4170</string>
  </array>
  <!-- launchd does NOT expand `~` or `$HOME` — use absolute paths. -->
  <key>WorkingDirectory</key>
  <string>/Users/YOUR-USERNAME/your-project</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- DO NOT COMMIT this file with a real token. Also chmod 600 the
         plist itself so the inlined token is not world-readable. -->
    <key>QWEN_SERVER_TOKEN</key>
    <string>PASTE-YOUR-TOKEN-HERE</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart only on non-zero exits (matches systemd Restart=on-failure).
       A bare `<true/>` would respawn even after a clean SIGTERM, making
       `kill <pid>` impossible to use as a stop signal — operator would
       have to `launchctl unload`. SuccessfulExit=false fixes that. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- Throttle restart storms on persistent failures (mirrors systemd
       RestartSec=5; launchd's default would respawn every <1s). -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- Log into the user's Library, not /tmp. /tmp is world-writable
       (symlink-attack risk on shared workstations) and gets cleaned by
       periodic-daily after 3 days; `~/Library/Logs/qwen-serve/` is
       user-scoped and survives. launchd truncates these on every
       `load`, so the unload→load token-rotation cycle wipes prior
       diagnostic logs — back them up if you need post-incident
       inspection. -->
  <key>StandardOutPath</key>
  <string>/Users/YOUR-USERNAME/Library/Logs/qwen-serve/out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR-USERNAME/Library/Logs/qwen-serve/err.log</string>
</dict>
</plist>
```

Manage:

```bash
mkdir -p ~/Library/Logs/qwen-serve                                       # first time only
chmod 600 ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist             # plist holds the inline token
launchctl load   ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist
launchctl unload ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist      # to stop
tail -f ~/Library/Logs/qwen-serve/out.log ~/Library/Logs/qwen-serve/err.log
```

After editing the plist (e.g., rotating the token) you must `unload` then `load` again — `launchctl` does not auto-reload on plist changes the way `systemd daemon-reload` does. Note: each `load` truncates the log files, so save them off if you're investigating an incident before rotating.

## tmux session (interactive supervision)

Assumes `QWEN_SERVER_TOKEN` is already exported in your shell (see the setup section above):

```bash
tmux new -d -s qwen-serve "cd ~/your-project && qwen serve --hostname 127.0.0.1"
tmux attach -t qwen-serve   # see live logs; Ctrl-b d to detach
tmux kill-session -t qwen-serve
```

`tmux new -d` inherits the parent shell's environment, so `QWEN_SERVER_TOKEN` flows through automatically. Best when you want to occasionally watch the daemon's stdout (auth warnings, MCP discovery progress, slow-client warnings) without committing to a service unit. Survives terminal close but not host reboot.

## nohup one-liner (quick + dirty)

Assumes `QWEN_SERVER_TOKEN` is already exported in your shell:

```bash
nohup bash -c 'cd ~/your-project && qwen serve --hostname 127.0.0.1' > qwen-serve.log 2>&1 &
echo $!  # daemon PID; capture if you want to `kill` cleanly later
```

The wrapping `bash -c '...'` ensures the daemon binds to `~/your-project` rather than wherever you happened to run the command. Without that `cd`, `qwen serve` defaults to `process.cwd()` and a `POST /session` from a client expecting your project workspace returns `400 workspace_mismatch` — silent foot-gun.

OK for one-off "let me run this in the background while I poke at the API" workflows. **Not recommended** for anything beyond a single session — no restart-on-crash, log file grows unbounded, no clean way to find the daemon if you forget the PID. Prefer tmux for interactive supervision or systemd / launchd for anything you want to outlast a reboot.

## Verifying the daemon is up

```bash
curl http://127.0.0.1:4170/health                                   # → {"status":"ok"}
curl -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  http://127.0.0.1:4170/capabilities | jq .protocolVersions         # daemon's feature set
```

When auth is configured (i.e., the daemon was started with `--token` / `QWEN_SERVER_TOKEN` set, OR `--require-auth=true`), every route except `/health` on loopback binds requires `Authorization: Bearer <token>`. If you started the daemon without a token on the loopback default (the `qwen serve` zero-config path), neither call requires a header. The templates above all configure a token, so the `Authorization` header is needed in practice. If `/capabilities` returns `401`, the unit / plist token doesn't match the env-exported token your `curl` is using.

## Token rotation

1. Generate a new token + write the env file the unit references:
   ```bash
   openssl rand -hex 32 > ~/.qwen-serve-token
   chmod 600 ~/.qwen-serve-token
   echo "QWEN_SERVER_TOKEN=$(cat ~/.qwen-serve-token)" > ~/.qwen-serve-token-env
   chmod 600 ~/.qwen-serve-token-env
   ```
   (For the launchd / nohup / tmux templates: edit the plist's `<string>` value or re-`export QWEN_SERVER_TOKEN`. Don't forget `chmod 600` on the plist if you regenerate it.)
2. Restart the daemon:
   - **systemd**: `systemctl --user restart qwen-serve.service`
   - **launchd**: `launchctl unload ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist && launchctl load ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist`
   - **tmux / nohup**: `kill <pid>` then re-run with the new token in env
3. Update any client SDKs / scripts. The TypeScript SDK's `DaemonClient` reads `QWEN_SERVER_TOKEN` automatically (PR 27 fallback) — re-`export` the new value in any client shell and reconstruct the client.

## Restart and crash behavior

Service-manager restart semantics differ across the templates:

- **systemd `Restart=on-failure`** — restart only on non-zero exit / signal. A clean SIGTERM (`systemctl stop`) does **not** trigger a restart loop.
- **launchd `KeepAlive` with `SuccessfulExit=false`** (the template above) — matches systemd behavior. A bare `<true/>` would have respawned even after a clean exit. `ThrottleInterval=10` rate-limits restart storms on persistent failures, mirroring systemd's `RestartSec=5`.
- **tmux / nohup** — no automatic restart. A daemon crash leaves you with a dead PID until you re-run.

Within a **single daemon process lifetime**, client disconnects recover via SSE `Last-Event-ID` resume per the [Durability model](./qwen-serve.md#durability-model) section of the user guide — the replay ring is in-memory.

A daemon **restart** drops all in-memory sessions; clients reconnect and start fresh. Cross-restart durability of session content (prompts, tool calls, conversation history) is **NOT** in v0.16-alpha.

## Out of scope (defers to v0.16.x or later)

- **Containerized deployment** — Dockerfile, docker-compose, Kubernetes manifests, nginx + TLS reverse proxy, multi-instance token isolation. Defers to v0.16.x once an enterprise pilot is committed; the doc would otherwise rot from no-one-validating.
- **Cross-host federation / multi-daemon coordination on one host** — `1 daemon = 1 workspace × N sessions` is enforced. Instance-path token keying + stale-token cleanup defer to v0.16.x.
- **Auto-generated daemon tokens** — alpha is BYO-token. Auto-gen + token-store infrastructure defers to v0.16.x.
- **Windows native service** (`nssm`, Service Control Manager wrapper) — for now use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/) and follow the systemd section above.

See the [v0.16-alpha known limits](./qwen-serve.md#v016-alpha-known-limits) callout in the main user guide for the full deferred-features list, and [#4175](https://github.com/QwenLM/qwen-code/issues/4175) for the v0.16-alpha rollout tracking issue.
