#!/usr/bin/env bash
# Emit docker-container driver opts that route buildkitd's own registry
# traffic through the host's egress proxy — but only where that proxy
# exists and answers. Prints nothing otherwise, so hosted runners and the
# HK pool keep their default direct route.
#
# Why this exists (#16039, #16162): the docker-container driver runs
# buildkitd in a container that inherits NEITHER the runner process's
# proxy env NOR the host network namespace. On the mainland release hosts
# the DNS answer for registry-1.docker.io is poisoned, so buildkitd's
# direct dial times out while resolving the pinned node:22-slim base —
# before any application build step. The host-level proxies (dockerd
# systemd override, runner service env) cannot reach it:
#   env.*        puts the proxy into buildkitd's own process environment,
#                which its registry resolver reads;
#   network=host makes 127.0.0.1:7890 inside the container reach the host
#                proxy instead of the container's own loopback.
# Both opts are load-bearing; verified on ecs-qwen-hz1-17/18 where the
# unopted probe fails with `dial tcp <poisoned IP>:443: i/o timeout` and
# the opted build resolves the pinned digest for both platforms.
#
# The decision is fail-closed: a configured-but-broken proxy must not
# capture buildkitd, and a host without the marker file must not receive
# opts pointing at a dead port. The probe log goes to stderr so the next
# broken build has the measurement in its step log (#16218 precedent).
set -euo pipefail

# Overridable for the test replay; production reads the fleet-managed file.
PROXY_ENV_FILE="${QWEN_PROXY_ENV_FILE:-/etc/qwen-proxy-client/proxy.env}"

note() { echo "buildkitd proxy: $*" >&2; }

# Unreadable counts as absent: under set -e a failing read would kill the
# whole build instead of falling back to the default direct route.
if [ ! -f "${PROXY_ENV_FILE}" ] || [ ! -r "${PROXY_ENV_FILE}" ]; then
  note "none (no readable ${PROXY_ENV_FILE})"
  exit 0
fi

proxy_url="$(sed -n 's/^https_proxy=//p' "${PROXY_ENV_FILE}" 2> /dev/null | head -n 1 || true)"
# Single-line http(s) URL only, with no CSV metacharacters: buildx parses
# each driver-opt as CSV (csvToMap), so a comma or double quote in the
# value could split one emitted line into injected options — or fail
# builder creation outright. Whitespace is excluded for the same reason.
url_re='^https?://[^[:space:],"]+$'
if ! [[ "${proxy_url}" =~ ${url_re} ]]; then
  note "none (no usable https_proxy in ${PROXY_ENV_FILE})"
  exit 0
fi

if ! command -v curl > /dev/null 2>&1; then
  note "none (curl unavailable)"
  exit 0
fi

# 401 is the healthy unauthenticated answer from the real registry; 200
# would prove reachability too. Anything else (000 timeout, 5xx) leaves
# buildkitd on its default direct route rather than aiming it at a proxy
# that cannot carry the traffic.
# `--noproxy ''` is load-bearing: curl consults the no-proxy list after
# picking a proxy, so an inherited NO_PROXY/no_proxy matching the registry
# (including `*`) would send this probe direct and let a dead proxy pass as
# healthy. Clearing the list for this one invocation is the only lever here;
# a NO_PROXY driver-opt is not an option (see the note below).
code="$(curl -s -o /dev/null --max-time 5 --noproxy '' -x "${proxy_url}" \
  -w '%{http_code}' 'https://registry-1.docker.io/v2/' 2> /dev/null || true)"
case "${code}" in
  200 | 401) ;;
  *)
    note "none (registry probe via ${proxy_url} returned ${code:-000})"
    exit 0
    ;;
esac

note "${proxy_url} (registry probe ${code})"
# No NO_PROXY line on purpose: buildx CSV-parses each driver-opt, and a
# comma list breaks builder creation both unquoted ("expecting k=v") and
# value-quoted ("bare \" in non-quoted-field") — both forms rejected by
# buildx v0.38.1 live. buildkitd only dials external registries, so a
# loopback exclusion list buys nothing. Every emitted line is free of
# CSV metacharacters: the URL validator above excludes commas/quotes.
cat << EOF
network=host
env.HTTP_PROXY=${proxy_url}
env.HTTPS_PROXY=${proxy_url}
env.http_proxy=${proxy_url}
env.https_proxy=${proxy_url}
EOF
