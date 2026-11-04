# shellcheck shell=bash
# Sourced by run-e2e-tests.sh and run-release-docker-integration.sh — both build
# the sandbox image with `npm run build:sandbox`, and both need the same apt
# source selection. Defines apt_mirror_probe_rate / select_apt_mirror; executes
# nothing on its own.
#
# The Dockerfile's built-in apt source is deb.debian.org. On the pool's
# mainland-China hosts that CDN path has been measured at 11-45 kB/s, which
# turns its two apt layers into a 2-3 hour build against the job's execution
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
  # mirrors.cloud.aliyuncs.com is the Alibaba Cloud VPC intranet mirror: it
  # answers from inside the VPC and does not consume the instance's capped
  # 100 Mbps public egress that throttles the public mirrors under concurrent
  # load — the same reason configure-maven-mirror.sh prefers it for Central.
  # Hosted runners and the Hong Kong hosts cannot reach it, so the probe just
  # measures 0 there and it loses to a reachable public mirror; no host map is
  # needed. Listed first because where it answers it is the fastest path.
  for mirror in mirrors.cloud.aliyuncs.com mirrors.aliyun.com mirrors.tuna.tsinghua.edu.cn; do
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

# Applies the probe to the sandbox build: exports BUILD_SANDBOX_FLAGS with the
# selected APT_MIRROR build arg (preserving any flags already set, e.g. the CI
# sandbox label) and logs the decision. A no-op selection leaves the flags
# untouched so the Dockerfile keeps its built-in deb.debian.org source.
apply_apt_mirror() {
  local apt_mirror
  apt_mirror="$(select_apt_mirror)"
  if [ -n "${apt_mirror}" ]; then
    export BUILD_SANDBOX_FLAGS="${BUILD_SANDBOX_FLAGS:-} --build-arg APT_MIRROR=${apt_mirror}"
    echo "apt mirror: ${apt_mirror} (probe measured deb.debian.org as slower)"
  else
    echo "apt mirror: deb.debian.org (probe found no faster mirror)"
  fi
}
