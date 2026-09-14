# ECS Runner host cleanup

This directory contains host-level cleanup for dedicated Linux ECS GitHub
Actions runner hosts. It complements per-job workflow cleanup; it does not
replace it.

## What it does

- Runs `qwen-docker-cleanup` once a day at 02:30 UTC, with up to 30 minutes of
  randomized delay.
- Removes Qwen CI containers — sandbox-labelled or named `qwen-code-*` —
  created more than 24 hours ago.
- Prunes sandbox-labelled Qwen CI images and dangling images older than 24
  hours.
- Uses the existing Qwen sandbox daemon lock to avoid concurrent Docker
  maintenance.
- Changes the host `/tmp` retention policy from 30 days to 7 days through
  `systemd-tmpfiles`.

Use this only on dedicated CI hosts. A sandbox-labelled or `qwen-code-*`-named
container older than 24 hours is considered leaked and may be removed even if
it is still running.

## Prerequisites

- Linux with systemd
- Docker available as `docker.service`
- `flock` and `timeout`
- Root access for installation
- Runner workspaces under `/home/github-runner`

## Install or update

From a Qwen Code checkout, run:

```bash
sudo .github/scripts/ecs-runner/install-qwen-docker-cleanup.sh
```

The installer copies the cleanup command and systemd units into the host,
installs the seven-day `/tmp` policy, reloads systemd, and enables the timer.
Run the same command again after pulling a newer version to update the host.

## Verify

```bash
systemctl is-enabled qwen-docker-cleanup.timer
systemctl is-active qwen-docker-cleanup.timer
systemctl list-timers qwen-docker-cleanup.timer
systemd-tmpfiles --cat-config | grep '^D /tmp '
```

The expected `/tmp` policy is:

```text
D /tmp 1777 root root 7d
```

## Run manually

Drain the host first if it may contain a legitimate job or container running
for more than 24 hours. Then run:

```bash
sudo systemctl start qwen-docker-cleanup.service
sudo journalctl -u qwen-docker-cleanup.service --since today
```

To apply the `/tmp` retention policy immediately:

```bash
sudo systemd-tmpfiles --clean --prefix=/tmp
```

## Disable or uninstall

```bash
sudo systemctl disable --now qwen-docker-cleanup.timer
sudo systemctl clean --what=state qwen-docker-cleanup.timer
sudo rm -f /usr/local/sbin/qwen-docker-cleanup
sudo rm -f /etc/systemd/system/qwen-docker-cleanup.service
sudo rm -f /etc/systemd/system/qwen-docker-cleanup.timer
sudo rm -f /etc/tmpfiles.d/tmp.conf
sudo systemctl daemon-reload
```

Removing `/etc/tmpfiles.d/tmp.conf` restores the operating system's packaged
`/tmp` policy on the next `systemd-tmpfiles` invocation.

## Scope

This cleanup intentionally does not delete runner workspaces, package caches,
containerd leases, or containerd snapshots directly. Those resources require
separate disk-pressure monitoring and a host drain before manual cleanup.
