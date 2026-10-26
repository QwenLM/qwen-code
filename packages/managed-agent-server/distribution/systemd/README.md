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
install -m 0600 -o qwen-managed-agent -g qwen-managed-agent \
  harness.env.example /etc/qwen-managed-agent/harness.env
install -m 0640 -o root -g qwen-managed-agent \
  server.env.example /etc/qwen-managed-agent/server.env
install -m 0600 -o qwen-managed-agent -g qwen-managed-agent \
  ../config/application.example.yml /etc/qwen-managed-agent/application.yml
```

The control plane reads `application.yml` and `harness.env` as
`qwen-managed-agent`, so those files are owned by the service account at
`0600`. The preflight warns, in its `config` and `credentials` rows, when a
secret file is group- or world-readable; a WARN does not fail `--check`, so
apply the `chmod 600` it prints. A `root`-owned `0600` `harness.env` would be
unreadable to the service, which the `credentials` row reports as FAIL.
`server.env` sets `QWEN_MANAGED_AGENT_SERVICE_USER=qwen-managed-agent`, so both
rows check access as that account, including every directory on the file's
path and along any symbolic link's target, even when `--check` runs as root;
the `service-user` row shows the account and its groups. `systemd` reads
environment files as root, so `0640 root:qwen-managed-agent` is enough for
`server.env`.

The Harness token and capability digest live only in `harness.env`:
`server.env` points `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` at it, and
the control plane refuses to start when that file is set together with
`QWEN_MANAGED_AGENT_HARNESS_TOKEN` or `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST`,
or when its Broker token is set together with
`QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN`.
Keep each credential, and the Broker URL, in `harness.env` as `KEY=value` on
one line, with LF line endings, no whitespace around the `=`, and only letters,
digits and `._:/+=-` in the value (the Broker URL may also use `[` and `]` to
bracket an IPv6 literal, as in `http://[::1]:4182`), and start comments with
`#`. The control plane refuses anything else, such as a continuation, a `;`
comment or text after a closing quote, since systemd or a shell would read it
differently.
For the tool path, uncomment `QWEN_MANAGED_RUNTIME_BROKER_URL` and
`QWEN_MANAGED_RUNTIME_BROKER_TOKEN` in `harness.env`. The control plane reads
the same token from it, so `server.env` carries no Broker token. On an upgraded
host, replace a `QWEN_HOSTED_HARNESS_BROKER_ARGS` line with these two: nothing
reads it any more. The Harness never moves off port 4170: if the port is in
use, it exits instead of running where `QWEN_MANAGED_AGENT_HARNESS_BASE_URL`
cannot reach it, and systemd restarts it every 5 seconds;
`journalctl -u qwen-hosted-harness` shows the port message.
The Session Store needs no setting of its own: the control plane derives its
URL from its own listener, which does not follow the Harness port, and its
workspace ID from `QWEN_MANAGED_AGENT_WORKSPACE_CWD`, the directory created
above.

Alternatively, generate all three files with these owners and modes, as root:

```bash
../bin/qwen-managed-agent-bootstrap --directory /etc/qwen-managed-agent \
  --service-user qwen-managed-agent
mysql -u root < /etc/qwen-managed-agent/mysql-setup.sql
rm /etc/qwen-managed-agent/mysql-setup.sql
```

The bootstrap also generates the database password into `server.env` and writes
`mysql-setup.sql`, readable by root only, which creates the database and its
account.

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

## Extension execution

Execution is disabled by default. Enable package publishing separately, then set
`QWEN_MANAGED_AGENT_EXTENSION_EXECUTION_ENABLED=true`,
`QWEN_MANAGED_AGENT_EXTENSION_EXECUTION_MODE=linux-cgroup`, an absolute private
`QWEN_MANAGED_AGENT_EXTENSION_CACHE_DIRECTORY` outside Workspace storage, and
`QWEN_MANAGED_AGENT_EXTENSION_CGROUP_ROOT` to a writable delegated cgroup-v2
subtree on each LOCAL or SSH Runtime host. The service must receive delegation
from its administrator; a writable ordinary directory is insufficient. Missing
cgroup support fails activation; no process-group fallback is used.

Native macOS LOCAL requires explicit `developer-process-group` mode and an empty
cgroup root. Its receipt proves registered process groups only. It does not prove
that detached descendants were reclaimed and is not a production process-tree
profile. Recovery retains holds when the durable owner journal or stop proof is
missing or uncertain.
