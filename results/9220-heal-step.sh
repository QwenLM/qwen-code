set -uo pipefail
# Pool wipe idiom (serve-ab.yml, qwen-triage.yml): empties the
# workspace but keeps the directory itself for the retry checkout,
# so no cd-escape and no recreation are needed. The sudo leg only
# helps on pool members WITH passwordless sudo; on the rest a
# root-owned poisoning degrades to warn-and-retry — the heal chain
# must never fail, so the retry still runs against survivors.
WS="${GITHUB_WORKSPACE:?}"
# Canonicalize before matching: the kernel resolves non-canonical
# spellings to the guarded roots (`/home/.` -> /home, `//usr` ->
# /usr), so a raw string match lets them slip past the case arms.
# `-m` is GNU-only — a BSD realpath exits 1 on it and the fallback
# silently keeps the raw spelling. Safe here (this pool is
# Linux-only), and off-GNU the strip loop and the allowlist below
# are what still hold; the suite gates its GNU-only assertion on a
# host probe rather than assuming this line ran.
WS="$(realpath -m -- "$WS" 2>/dev/null || printf '%s' "$WS")"
# Trailing slashes slip past the exact-match case arms below
# (`/home/` would pass the guard and reach the rm); realpath strips
# them too, but this keeps the guard whole when realpath is absent.
while [ "${WS%/}" != "$WS" ]; do WS="${WS%/}"; done
case "$WS" in
  /|/home|/root|/usr*|/etc*|/var|"") echo "::error::refusing to wipe suspicious workspace path: $WS"; exit 1 ;;
esac
# A denylist can only enumerate known roots — the allowlist closes
# every other one (/tmp, /opt, ...): only a directory inside the
# runner workspace may be wiped.
RWS="${RUNNER_WORKSPACE:?}"
RWS="$(realpath -m -- "$RWS" 2>/dev/null || printf '%s' "$RWS")"
# Mirror the WS strip: without realpath, a trailing slash would
# turn the allowlist pattern into "$RWS"//* and refuse the real
# workspace; "/" stripped empty would match every path instead.
while [ "${RWS%/}" != "$RWS" ]; do RWS="${RWS%/}"; done
if [ -z "$RWS" ]; then echo "::error::refusing to wipe: runner workspace resolved to /"; exit 1; fi
case "$WS" in
  "$RWS"/*) ;;
  *) echo "::error::refusing to wipe workspace outside the runner workspace: $WS"; exit 1 ;;
esac
if find "$WS" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || sudo -n find "$WS" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; then
  echo "::warning::first checkout failed; wiped the workspace for a clean retry"
else
  echo "::warning::could not wipe the workspace; the retry checkout may fail again"
fi
# Triage counts survivors and exits 1; here the chain must stay
# alive for the retry, so survivors only get a signal.
remaining="$( (find "$WS" -mindepth 1 -maxdepth 1 2>/dev/null || true) | wc -l | tr -d ' ')"
if [ "$remaining" != '0' ]; then
  survivors="$( (find "$WS" -mindepth 1 -maxdepth 1 2>/dev/null || true) | tr '\n' ' ' | cut -c1-500)"
  echo "::warning::${remaining} entries survived the workspace wipe: ${survivors}; the retry checkout runs against them"
fi