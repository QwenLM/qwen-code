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

The same `QWEN_SERVER_TOKEN` env var is honored by:

- The daemon's `--token` CLI flag (read at boot)
- The TypeScript SDK's `DaemonClient` constructor (PR 27 fallback — clients with `export QWEN_SERVER_TOKEN=...` in their shell never need to thread the value through their script)

So one shell-level `export` covers both server and client.

## Linux: systemd user unit

`~/.config/systemd/user/qwen-serve.service`:

```ini
[Unit]
Description=Qwen Code daemon (loopback HTTP + SSE)
After=network.target

[Service]
Type=simple
# Replace with your project; %h expands to $HOME under user units.
WorkingDirectory=%h/your-project
ExecStart=/usr/local/bin/qwen serve --bind 127.0.0.1
# DO NOT COMMIT this file with a real token. Use a sealed-secret
# / chezmoi / sops / git-crypt setup if you check the unit file in.
Environment=QWEN_SERVER_TOKEN=PASTE-YOUR-TOKEN-HERE
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Manage:

```bash
systemctl --user daemon-reload
systemctl --user enable --now qwen-serve.service
journalctl --user -u qwen-serve -f          # tail logs
systemctl --user restart qwen-serve.service # after token rotation
systemctl --user disable --now qwen-serve.service
```

**System-wide alternative** (shared dev hosts, less common): drop the unit at `/etc/systemd/system/qwen-serve@.service` with `User=%i`, manage via `sudo systemctl enable --now qwen-serve@<username>.service`. Same `[Service]` body otherwise. Pick user-level for single-user workstations.

## macOS: launchd user agent

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
    <string>/usr/local/bin/qwen</string>
    <string>serve</string>
    <string>--bind</string>
    <string>127.0.0.1</string>
  </array>
  <!-- launchd does NOT expand `~` or `$HOME` — use absolute paths. -->
  <key>WorkingDirectory</key>
  <string>/Users/YOUR-USERNAME/your-project</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- DO NOT COMMIT this file with a real token. -->
    <key>QWEN_SERVER_TOKEN</key>
    <string>PASTE-YOUR-TOKEN-HERE</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/qwen-serve.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/qwen-serve.err.log</string>
</dict>
</plist>
```

Manage:

```bash
launchctl load   ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist
launchctl unload ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist  # to stop
tail -f /tmp/qwen-serve.out.log /tmp/qwen-serve.err.log
```

After editing the plist (e.g., rotating the token) you must `unload` then `load` again — `launchctl` does not auto-reload on plist changes the way `systemd daemon-reload` does.

## tmux session (interactive supervision)

```bash
tmux new -d -s qwen-serve "cd ~/your-project && qwen serve"
tmux attach -t qwen-serve   # see live logs; Ctrl-b d to detach
tmux kill-session -t qwen-serve
```

Best when you want to occasionally watch the daemon's stdout (auth warnings, MCP discovery progress, slow-client warnings) without committing to a service unit. Survives terminal close but not host reboot.

## nohup one-liner (quick + dirty)

```bash
nohup qwen serve --bind 127.0.0.1 > qwen-serve.log 2>&1 &
echo $!  # daemon PID; capture if you want to `kill` cleanly later
```

OK for one-off "let me run this in the background while I poke at the API" workflows. **Not recommended** for anything beyond a single session — no restart-on-crash, log file grows unbounded, no clean way to find the daemon if you forget the PID. Prefer tmux for interactive supervision or systemd / launchd for anything you want to outlast a reboot.

## Verifying the daemon is up

```bash
curl http://127.0.0.1:4170/health                                   # → {"status":"ok"}
curl -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  http://127.0.0.1:4170/capabilities | jq .protocolVersions         # daemon's feature set
```

`/health` is exempted from auth on loopback binds; `/capabilities` always requires auth. If `/capabilities` returns 401, the unit / plist token doesn't match the env-exported token your `curl` is using.

## Token rotation

1. Generate a new token: `openssl rand -hex 32 > ~/.qwen-serve-token-new`
2. Edit the unit file / plist / shell export with the new value
3. Restart the daemon:
   - **systemd**: `systemctl --user restart qwen-serve.service`
   - **launchd**: `launchctl unload ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist && launchctl load ~/Library/LaunchAgents/com.qwenlm.qwen-serve.plist`
   - **tmux / nohup**: `kill <pid>` then re-run with the new token in env
4. Update any client SDKs / scripts. The TypeScript SDK's `DaemonClient` reads `QWEN_SERVER_TOKEN` automatically (PR 27 fallback) — re-`export` the new value in any client shell and reconstruct the client.

## Restart and crash behavior

Service-manager restart works as expected (systemd `Restart=on-failure`, launchd `KeepAlive=true`). Sessions are in-memory and re-attach via SSE `Last-Event-ID` resume per the [Durability model](./qwen-serve.md#durability-model) section of the user guide. Cross-restart durability of session content (prompts, tool calls, conversation history) is **NOT** in v0.16-alpha — a daemon restart drops sessions; clients reconnect and start fresh.

## Out of scope (defers to v0.16.x or later)

- **Containerized deployment** — Dockerfile, docker-compose, Kubernetes manifests, nginx + TLS reverse proxy, multi-instance token isolation. Defers to v0.16.x once an enterprise pilot is committed; the doc would otherwise rot from no-one-validating.
- **Cross-host federation / multi-daemon coordination on one host** — `1 daemon = 1 workspace × N sessions` is enforced. Instance-path token keying + stale-token cleanup defer to v0.16.x.
- **Auto-generated daemon tokens** — alpha is BYO-token. Auto-gen + token-store infrastructure defers to v0.16.x.
- **Windows native service** (`nssm`, Service Control Manager wrapper) — for now use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/) and follow the systemd section above.

See the [v0.16-alpha known limits](./qwen-serve.md#v016-alpha-known-limits) callout in the main user guide for the full deferred-features list, and [#4175](https://github.com/QwenLM/qwen-code/issues/4175) for the v0.16-alpha rollout tracking issue.
