# systemd units

[English](README.md) | [简体中文](README.zh-CN.md)

Templates for the accepted single-host topology: one Hosted Harness, one Java
control plane, and MySQL on the same trusted Linux host. These units manage the
Harness and the control plane only; MySQL is outside their scope. Review every
path and user before enabling them.

## Install

1. Extract the distribution to `/opt/qwen-managed-agent`.
2. Create the service account and directories:

```bash
useradd --system --home /var/lib/qwen-managed-agent \
  --shell /usr/sbin/nologin qwen-managed-agent
install -d -o qwen-managed-agent -g qwen-managed-agent /srv/qwen-workspace
install -d -m 0750 -o root -g qwen-managed-agent /etc/qwen-managed-agent
```

3. Install the environment files and the key ring, then edit all three. Run
   these commands from this `systemd/` directory:

```bash
install -m 0640 -o root -g qwen-managed-agent \
  harness.env.example /etc/qwen-managed-agent/harness.env
install -m 0640 -o root -g qwen-managed-agent \
  server.env.example /etc/qwen-managed-agent/server.env
install -m 0600 -o qwen-managed-agent -g qwen-managed-agent \
  ../config/application.example.yml /etc/qwen-managed-agent/application.yml
```

The control plane reads `application.yml` as `qwen-managed-agent`, so that file
is owned by the service account at `0600`. The preflight rejects a secret file
that is group- or world-readable, and a `root`-owned `0600` file would be
unreadable to the service. `systemd` reads the two environment files as root,
so `0640 root:qwen-managed-agent` is enough for them.

The Harness token and capability digest must match in `harness.env` and
`server.env`. If the Harness reports a port other than 4170 because the
requested one was in use, update `QWEN_MANAGED_AGENT_HARNESS_BASE_URL` in
`server.env` before starting the control plane.
`QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` is separate: it names this Java
control plane's own listener (`http://127.0.0.1:8080` in the template) and does
not follow the Harness port.

Alternatively, `../bin/qwen-managed-agent-bootstrap --directory
/etc/qwen-managed-agent` generates all three files; adjust their ownership and
mode for the service account afterwards.

4. Install and start:

```bash
install -m 0644 qwen-hosted-harness.service \
  qwen-managed-agent-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qwen-hosted-harness qwen-managed-agent-server
```

Adjust `ExecStart` in the Harness unit when `qwen` is installed outside
`/usr/local/bin`. Both units set `ProtectHome=true`, so the executable that
`qwen` resolves to must live outside `/home`, `/root` and `/run/user`; a
`/usr/local/bin/qwen` symlink into a home directory fails with `203/EXEC`.
Check with `readlink -f "$(command -v qwen)"`.

## Verify

Load the same environment file the unit uses, then run the preflight while the
service is stopped:

```bash
sudo systemd-run --wait --pipe --collect \
  --property=User=qwen-managed-agent \
  --property=EnvironmentFile=/etc/qwen-managed-agent/server.env \
  /opt/qwen-managed-agent/bin/qwen-managed-agent-server --check
curl --fail http://127.0.0.1:8080/actuator/health
```

`--check` binds the configured ports, so it reports a false failure while the
service is running.

## Why the kill modes differ

`KillMode=process` on the control plane leaves Runtime workers running when the
Broker restarts; the default `control-group` would terminate them with the
server. `KillMode=mixed` on the Harness terminates its tool processes with it.
Keep both settings unless an equivalent supervisor replaces them.

The same `KillMode=process` means `systemctl stop qwen-managed-agent-server`
signals only the main process: the unit reports inactive while Runtime workers
keep the state directory and Workspace, and a following start races them. Reap
them before restarting with
`systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server`.

## Paths

- `/opt/qwen-managed-agent` — extracted distribution (read-only).
- `/etc/qwen-managed-agent` — credentials and `application.yml`.
- `/var/lib/qwen-managed-agent` — Runtime state.
- `/srv/qwen-workspace` — Workspace; adjust `ReadWritePaths` when it moves.
