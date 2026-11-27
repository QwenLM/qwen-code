#!/usr/bin/env bash
# Run a loopback-only browser test command inside an isolated Linux network
# namespace (bubblewrap `--unshare-net`) on self-hosted runners.
#
# Shared ECS hosts run Docker-backed jobs (such as `sandbox:docker` and MySQL
# integration suites) beside `web-shell E2E Smoke`. Every `net=bridge`
# container start/stop adds or removes a `veth*` interface on `docker0`, which
# broadcasts kernel netlink route/link events. Chromium's
# `NetworkChangeNotifierLinux` aborts all in-flight requests — including
# `http://127.0.0.1` Vite dev-server module loads — with
# `net::ERR_NETWORK_CHANGED`.
#
# Wrapping the smoke command in `bwrap --unshare-net` gives Vite and Playwright
# a private network namespace containing only `lo` (`127.0.0.1/8`, `::1/128`),
# completely shielding Chromium from host-level interface churn without
# splitting runner capacity or mutating host configuration.
#
# Usage: run-in-isolated-netns.sh [--] <command> [args...]
set -euo pipefail

if [ "${1:-}" = '--' ]; then
  shift
fi

if [ "$#" -eq 0 ]; then
  echo '::error::run-in-isolated-netns.sh: missing command to execute' >&2
  exit 2
fi

isolate=0
case "${QWEN_FORCE_ISOLATED_NETNS:-}" in
  1)
    isolate=1
    ;;
  '' | 0)
    case "${RUNNER_ENVIRONMENT:-}" in
      self-hosted)
        isolate=1
        ;;
      github-hosted | '')
        isolate=0
        ;;
      *)
        echo "::error::run-in-isolated-netns.sh: unexpected RUNNER_ENVIRONMENT='${RUNNER_ENVIRONMENT}' (expected 'self-hosted', 'github-hosted', or empty)" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "::error::run-in-isolated-netns.sh: unexpected QWEN_FORCE_ISOLATED_NETNS='${QWEN_FORCE_ISOLATED_NETNS}' (expected '0', '1', or empty)" >&2
    exit 2
    ;;
esac

if [ "$isolate" -eq 0 ]; then
  exec "$@"
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "::error::run-in-isolated-netns.sh: bubblewrap ('bwrap') is required on self-hosted runners to isolate browser tests from host Docker/veth network changes (net::ERR_NETWORK_CHANGED), but was not found in PATH." >&2
  exit 1
fi

# Do not pass `--die-with-parent`: Linux `PR_SET_PDEATHSIG` fires SIGKILL (137)
# when the spawning *thread* exits, so `exec`'ing `bwrap` directly under a
# multi-threaded parent such as `.NET Runner.Worker` kills `bwrap` mid-run when
# the ThreadPool retires that worker thread (observed on job 140587110681 after
# 3m50s). GitHub Actions already tracks and reaps step processes via
# `RUNNER_TRACKING_ID`.
if ! bwrap --unshare-net --dev-bind / / -- true; then
  echo '::error::run-in-isolated-netns.sh: bwrap failed to enter an isolated network namespace on this host; refusing to fall back to the shared host network.' >&2
  exit 1
fi

echo 'run-in-isolated-netns.sh: running in isolated loopback-only network namespace (bwrap --unshare-net)'

# Strip host proxy variables inside the isolated netns: a host-side loopback
# proxy (e.g. 127.0.0.1:7890) does not listen inside the private netns, and the
# wrapped suite only talks to 127.0.0.1 Vite/mock servers.
exec env \
  -u HTTP_PROXY \
  -u HTTPS_PROXY \
  -u ALL_PROXY \
  -u NO_PROXY \
  -u http_proxy \
  -u https_proxy \
  -u all_proxy \
  -u no_proxy \
  bwrap --unshare-net --dev-bind / / --chdir "$PWD" -- "$@"
