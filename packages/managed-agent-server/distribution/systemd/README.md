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
install -m 0640 -o root -g qwen-managed-agent \
  ../config/application.example.yml /etc/qwen-managed-agent/application.yml
```

The Harness token and capability digest must match in `harness.env` and
`server.env`.

4. Install and start:

```bash
install -m 0644 qwen-hosted-harness.service \
  qwen-managed-agent-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qwen-hosted-harness qwen-managed-agent-server
```

Adjust `ExecStart` in the Harness unit when `qwen` is installed outside
`/usr/local/bin`.

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

## Paths

- `/opt/qwen-managed-agent` — extracted distribution (read-only).
- `/etc/qwen-managed-agent` — credentials and `application.yml`.
- `/var/lib/qwen-managed-agent` — Runtime state.
- `/srv/qwen-workspace` — Workspace; adjust `ReadWritePaths` when it moves.
