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
- Reclaims unused Docker build cache last used more than 24 hours ago, with
  a 30 GB cache retention budget. Recent and in-use cache is preserved, so
  this is not a hard disk-usage cap. Failures mark the service as failed.
- Uses the existing Qwen sandbox daemon lock for labelled image pruning.
  Build-cache pruning relies on Docker's in-use protection and runs even
  when that lock is busy or missing.
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
Merging changes does not update installed copies. Run the installer on every
host, including hosts that do not yet have the timer, and check each host's
timer and journal below. Updating the global Qwen CLI does not install this
cleanup service.

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

The PR review workflow creates a private scratch directory under `RUNNER_TEMP`,
exports it as `TMPDIR`, and asks the top-level agent to keep verification
copies there and pass the same requirement to its subagents. An `always()`
step removes that directory after artifact upload, including on failed or
cancelled reviews when cleanup steps can run. Cleanup failures are reported in
the job log.

This is a temporary-directory convention, not filesystem isolation: commands
that explicitly write elsewhere bypass it. Existing arbitrary copies in `/tmp`
remain covered only by the seven-day policy. This service does not remove them
by name because they may belong to an active job. A later review job on the
same runner registration retries removing stale `qwen-review-scratch.*`
directories from `RUNNER_TEMP`; residue on an idle registration still requires
manual cleanup. Build-cache reclamation does not initialize unused data disks.

## Regression check

```bash
node --test .github/scripts/ecs-runner/*.test.mjs
```

The check runs the cleanup script with mocked host commands and temporary
lock files; it does not contact Docker or remove real containers.
