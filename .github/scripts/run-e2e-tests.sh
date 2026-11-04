#!/usr/bin/env bash

set -euo pipefail

sandbox="${1:?usage: run-e2e-tests.sh <sandbox> <shard>}"
shard="${2:?usage: run-e2e-tests.sh <sandbox> <shard>}"

cleanup_e2e_job() {
  if [ "$sandbox" = 'sandbox:docker' ]; then
    container_ids="$(timeout 30 docker ps -aq --filter "label=org.qwen-code.ci.owner=${E2E_CONTAINER_OWNER}" 2>/dev/null)" || container_ids=''
    if [ -n "$container_ids" ]; then
      printf '%s\n' "$container_ids" | xargs -r timeout 60 docker rm -f > /dev/null 2>&1 || echo "::warning::failed to remove E2E containers for ${E2E_CONTAINER_OWNER}"
    fi
  fi
  if [ -n "${QWEN_CI_TMPDIR:-}" ]; then
    rm -rf "$QWEN_CI_TMPDIR" 2>/dev/null || true
  fi
}
trap cleanup_e2e_job EXIT
trap 'exit 1' INT TERM

if [ "$sandbox" = 'sandbox:docker' ]; then
  sandbox_image="$(node -p "require('./packages/cli/package.json').config.sandboxImageUri")-e2e-${GITHUB_SHA}"

  # 7>&- 8>&- 9>&- here and on the test command below: a lock
  # lives on the open file description, so a descendant that
  # inherits the descriptor and outlives this job keeps holding it.
  # Closing it in the child costs nothing — this shell keeps the
  # lock — and leaves no way to leak one onto the host.
  build_image() {
    npm run build:sandbox -- -s --no-prune -i "$sandbox_image" 7>&- 8>&- 9>&-
  }

  # The Dockerfile's built-in apt source is deb.debian.org. On the pool's
  # mainland-China hosts that CDN path has been measured at 11-20 kB/s, which
  # turns its two apt layers into a 2-3 hour build against this job's 60-minute
  # cap, so the leg is cancelled before any test runs (#16214). The same path
  # runs at MB/s from the Hong Kong hosts, and it recovers on the mainland hosts
  # at off-peak hours — so pinning either a mirror or a host list is wrong.
  # Probe every build instead: the fastest endpoint wins, a healthy default is
  # left alone, and no fleet map needs upkeep.
  apt_mirror_probe_rate() {
    # A 512 KiB range read of a file every Debian mirror carries. Any large
    # immutable index would do. The window matters more than the target: a
    # shorter read cannot tell a warm CDN edge from a throttled one, while this
    # one still finishes in well under a second wherever the path is healthy,
    # so a slow candidate costs at most the 4-second cap.
    local reply code rate
    reply="$(curl -s -o /dev/null --max-time 4 --range 0-524287 \
      -w '%{http_code} %{speed_download}' \
      "http://$1/debian/dists/bookworm/main/binary-arm64/Packages.gz" 2>/dev/null)" || true
    code="${reply%% *}"
    rate="${reply##* }"
    case "${code}" in
      200 | 206) printf '%s' "${rate%%.*}" ;;
      *) printf '0' ;;
    esac
  }

  select_apt_mirror() {
    command -v curl > /dev/null 2>&1 || return 0
    # Two gates, both on the mirror side. An absolute floor stops a "slow vs
    # slower" override (two crawling endpoints must not move a host onto a
    # mirror it never needed); the 4x factor keeps a genuinely fast default —
    # the Hong Kong hosts — on the built-in source, since a mirror there is
    # rarely 4x quicker. There is deliberately no "default looks healthy" gate:
    # the mainland paths are bimodal, a 512 KiB probe can catch a fast burst
    # (372 kB/s on hz4-2) while the sustained 200 MB transfer then throttles to
    # 45 kB/s and times out (#16214 recurrence, run 41743539611). Trusting the
    # mirror's own measured speed, not the default's, is what survives that.
    local fast_mirror=1000000
    local default_rate best_rate=0 best='' mirror rate
    default_rate="$(apt_mirror_probe_rate deb.debian.org)"
    default_rate="${default_rate:-0}"
    for mirror in mirrors.aliyun.com mirrors.tuna.tsinghua.edu.cn; do
      rate="$(apt_mirror_probe_rate "${mirror}")"
      rate="${rate:-0}"
      if [ "${rate}" -gt "${best_rate}" ]; then
        best="${mirror}"
        best_rate="${rate}"
      fi
    done
    # Print the measurements: the next person debugging a slow image build
    # should not have to re-run this probe by hand (#16214).
    echo "apt probe: deb.debian.org=${default_rate} B/s best=${best_rate} B/s (${best:-none})" >&2
    if [ -n "${best}" ] && [ "${best_rate}" -gt "${fast_mirror}" ] &&
      [ "${best_rate}" -gt $((default_rate * 4)) ]; then
      printf '%s' "${best}"
    fi
  }

  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    mkdir -p "${HOME}/.cache/qwen-code-ci"
    # Host daemon lock, shared for the whole step and never
    # upgraded: it only keeps the age-based prune (which takes it
    # exclusively, non-blocking) off a daemon with Docker work in
    # flight. #10605 upgraded it to exclusive to build an image,
    # which starves that shard behind the test-phase readers of
    # every other run on the host: in run 33637097713 shard 1/3
    # gave up on the write lock after 30 minutes while a shard of
    # run 33638984513 held the shared lock through its tests, and
    # shard 2/3 then timed out on the coordinator lock shard 1/3
    # was still holding.
    exec 9>"${HOME}/.cache/qwen-code-ci/docker-sandbox-daemon.lock"
    if ! flock --shared --wait 1800 9; then
      echo "::error::docker daemon read lock not acquired within 30 minutes"
      exit 1
    fi
    # Per-commit coordinator: one job builds the image; a concurrent
    # run at the same SHA waits here and then finds it present.
    exec 8>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build-e2e-${GITHUB_SHA}.lock"
    if ! flock --wait 1800 8; then
      echo "::error::docker build coordinator lock not acquired within 30 minutes"
      exit 1
    fi
  fi

  if ! docker image inspect "$sandbox_image" > /dev/null 2>&1; then
    if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
      # Host build mutex: keeps concurrent image builds off one
      # daemon. Held only while an image is prepared, never while
      # tests run, so the wait is bounded by a build.
      exec 7>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build.lock"
      if ! flock --wait 1800 7; then
        echo "::error::docker build lock not acquired within 30 minutes"
        exit 1
      fi
    fi
    # Label- and age-filtered, so it cannot touch the image a
    # concurrent shard is testing.
    timeout 20m docker image prune --all --force --filter 'label=org.qwen-code.ci.sandbox=true' --filter 'until=24h' || echo "::warning::old CI sandbox image cleanup failed on ${RUNNER_NAME:-this runner}"
    apt_mirror="$(select_apt_mirror)"
    if [ -n "${apt_mirror}" ]; then
      export BUILD_SANDBOX_FLAGS="${BUILD_SANDBOX_FLAGS:-} --build-arg APT_MIRROR=${apt_mirror}"
      echo "apt mirror: ${apt_mirror} (probe measured deb.debian.org as slower)"
    else
      echo "apt mirror: deb.debian.org (probe found no faster mirror)"
    fi
    if ! build_image; then
      echo "::warning::sandbox image build failed; retrying once"
      build_image
    fi
    if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
      flock --unlock 7
      exec 7>&-
    fi
  else
    echo "Reusing sandbox image for ${GITHUB_SHA}"
  fi

  sandbox_image_id="$(docker image inspect --format '{{.Id}}' "$sandbox_image")"
  export QWEN_SANDBOX_IMAGE="$sandbox_image_id"
  if [ "$RUNNER_ENVIRONMENT" = 'self-hosted' ]; then
    flock --unlock 8
    exec 8>&-
  fi
fi

export TMPDIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
if [ "${RUNNER_OS:-}" = 'Linux' ]; then
  QWEN_CI_TMPDIR="$(mktemp -d /var/tmp/qwen-ci-XXXXXX 2>/dev/null || true)"
  if [ -n "$QWEN_CI_TMPDIR" ]; then
    TMPDIR="$QWEN_CI_TMPDIR"
    export TMPDIR
  fi
fi

# QWEN_E2E_RENDERER=ink pins the baseline leg of the renderer
# matrix; the opentui leg runs in e2e-interactive-opentui below.
# The docker leg runs vitest directly instead of through
# test:integration:sandbox:docker: that script would rebuild the image
# the step above just built.
# Keep suites that launch many real CLI/daemon subprocesses out of
# the three-fork batch so they cannot starve each other's local control
# and HTTP requests.
run_vitest() {
  if [ "$sandbox" = 'sandbox:docker' ]; then
    npx cross-env QWEN_E2E_RENDERER=ink QWEN_SANDBOX=docker vitest run --root ./integration-tests "$@" 9>&-
  else
    QWEN_E2E_RENDERER=ink npm run test:integration:sandbox:none -- "$@"
  fi
}

bulk_args=(
  --exclude '**/interactive/cron-interactive.test.ts'
  --exclude '**/channel-plugin.test.ts'
  --exclude '**/chat-transcript-document.test.ts'
  --exclude '**/qwen-serve-routes.test.ts'
  --exclude '**/sdk-typescript/**'
  --poolOptions.forks.maxForks=3
  --shard="$shard"
)

run_shard() {
  run_vitest "${bulk_args[@]}" &&
    run_vitest sdk-typescript cli/qwen-serve-routes.test.ts --poolOptions.forks.maxForks=1
}

if [ "$sandbox" = 'sandbox:docker' ]; then
  run_shard
else
  # One bounded retry: pool runners' sandbox:none shards die under
  # shared-host pressure with every test green and no vitest FAIL
  # line — runs 33293739505, 33302550436 and 33317457036 failed
  # this leg on three different hosts while sibling shards of the
  # same runs passed, and the shard passes on re-run. The same
  # transient class the sandbox-image build retry above covers
  # (#10355). A deterministic test failure fails both attempts and
  # keeps the shard red. The retry is budget-gated on job-elapsed
  # time: two of those three runs died with ~10-12 of the 60 job
  # minutes left, less than one shard-time, where a retry can only
  # be cancelled mid-flight by timeout-minutes. The docker leg
  # keeps no retry: two ~30min attempts would outrun the job's
  # timeout-minutes.
  run_shard || {
    elapsed=$(( $(date +%s) - ${E2E_JOB_START_EPOCH:-0} ))
    # Budget gate: a retry needs a full shard-time inside the job's
    # timeout-minutes. 3600s minus a 25-minute reserve — the worst
    # measured shard is ~21min under shared-host pressure — leaves
    # 2100s; past that, GitHub cancels the retry mid-flight, burns
    # pool time, and the failure degrades to a timeout signature.
    if (( elapsed > 2100 )); then
      echo "::error::sandbox:none shard failed on ${RUNNER_NAME:-this runner} after ${elapsed}s of the 3600s job budget — not enough left for a retry"
      exit 1
    fi
    echo "::warning::sandbox:none shard failed on ${RUNNER_NAME:-this runner} after ${elapsed}s; retrying once (transient shared-host pressure class)"
    run_shard
  }
fi
