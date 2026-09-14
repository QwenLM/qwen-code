#!/usr/bin/env bash
set -uo pipefail

# Host-level mutex: only one cleanup per host at a time. Lives under /run, so
# it is root-owned by design and never collides with the shared sandbox daemon
# lock in the runner's home below.
exec 9>/run/qwen-docker-cleanup.lock || {
  echo 'error: cannot open /run/qwen-docker-cleanup.lock (running as root?)' >&2
  exit 1
}
flock --nonblock 9 || { echo 'skipped: another cleanup is already running' >&2; exit 0; }

# The sandbox daemon lock is created runner-owned by CI jobs on first use
# (${HOME}/.cache/qwen-code-ci/docker-sandbox-daemon.lock). Never create it
# here: this service runs as root, and a root-owned directory or lock file in
# the runner's home would make every later CI job's `exec 9>` fail with EACCES
# under `set -e`.
runner_home=$(getent passwd github-runner | cut -d: -f6 || true)
daemon_lock="${runner_home:-/home/github-runner}/.cache/qwen-code-ci/docker-sandbox-daemon.lock"

# Reap leaked containers older than 24h. `--all` includes stopped containers;
# the age gate, not the daemon lock, is what protects still-running jobs, so
# the lock is only taken around the labelled prune below.
now=$(date +%s)
reap_stale() {
  local filter="$1" now="$2"
  while read -r id; do
    [[ -n "$id" ]] || continue
    created=$(docker inspect --format '{{.Created}}' "$id" 2>/dev/null) || continue
    created_at=$(date -d "$created" +%s 2>/dev/null) || continue
    if ((now - created_at > 86400)); then
      docker rm --force "$id" || echo "warning: failed to remove stale container $id" >&2
    fi
  done < <(docker ps --all --quiet --filter "$filter")
}
# e2e/release containers carry the sandbox label (set at image build time);
# autofix/review containers come from the published image, which does not, and
# are named qwen-code-*.
reap_stale 'label=org.qwen-code.ci.sandbox=true' "$now"
reap_stale 'name=qwen-code-' "$now"

# Dangling images are untagged and unreferenced, so this prune needs no daemon
# lock and runs even on hosts that never create it.
docker image prune --force --filter 'until=24h' || echo 'warning: dangling image prune failed' >&2

# Take the shared daemon lock exclusively, non-blocking, only around the
# labelled prune — the same shape as the job's own prune step. Holding it
# across the reap loop above would starve CI jobs waiting on `flock --shared
# --wait 1800` for the whole step. Append (not `>`) so opening the lock never
# truncates an inode another process is holding a flock on. Skip the prune
# when the lock has never been created: it exists only after a docker
# e2e/release leg has run, and creating it here as root would break later CI.
if [[ ! -e "$daemon_lock" ]]; then
  echo "skipped: no sandbox daemon lock at $daemon_lock; labelled image prune skipped" >&2
  exit 0
fi
exec 8>>"$daemon_lock" || {
  echo "error: cannot open sandbox daemon lock at $daemon_lock" >&2
  exit 1
}
flock --nonblock 8 || { echo 'skipped: sandbox daemon lock busy' >&2; exit 0; }

timeout 20m docker image prune --all --force \
  --filter 'label=org.qwen-code.ci.sandbox=true' \
  --filter 'until=24h' || echo 'warning: Qwen CI image prune failed' >&2
