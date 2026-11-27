#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Production CLI capability gate for the tiered /review cutover.
#
# The published CLI on a review runner may predate the tiered sandbox: its
# policy parser only knows off/auto/required and silently maps an unknown
# `tiered` to `off`, which would hand the PR's install/build/test this job's
# credentials. A version string cannot prove capability, so probe BEHAVIOUR:
# run the candidate CLI's own `review build-test` against a workflow-authored
# trusted fixture whose preinstall writes a canary marker. A CLI that honours
# `tiered` + QWEN_REVIEW_FORCE_HARDWARE=1 refuses before executing anything
# (report carries executionBoundary policy=tiered / executionClass=
# hardware-isolated / backend=refused and no canary); a CLI that silently
# downgrades executes the canary and/or omits the boundary. Only this script's
# own fixture code ever runs here — never PR code. On failure: try the newest
# published release, then build the CLI from the trusted base checkout, re-probe,
# and refuse explicitly if still unsupported. Never fall through to an
# unsupported CLI. Kept out of the workflow YAML so the size ratchet stays green.
set -euo pipefail

probe_dir="$(mktemp -d "${RUNNER_TEMP:?}/qwen-review-cli-probe.XXXXXX")"
trap 'rm -rf "$probe_dir"' EXIT
wt="$probe_dir/.qwen/tmp/review-probe"
mkdir -p "$wt"
cat > "$wt/package.json" <<'PROBE_PKG'
{"name":"cli-capability-probe","version":"1.0.0","private":true,"scripts":{"preinstall":"node -e \"require('node:fs').writeFileSync('canary-marker','executed')\"","test":"node -e \"process.exit(0)\""}}
PROBE_PKG
cat > "$wt/package-lock.json" <<'PROBE_LOCK'
{"name":"cli-capability-probe","lockfileVersion":3,"requires":true,"packages":{}}
PROBE_LOCK
mkdir -p "$wt/src"
printf 'export const probe = 1;\n' > "$wt/src/a.ts"
plan="$probe_dir/plan.json"
printf '{"pr":0,"head":"probe","base":"probe","mergeBase":"probe","isCrossRepository":false,"authorAssociation":"MEMBER","diffStat":{"files":1,"added":1,"deleted":0},"files":[{"path":"src/a.ts","added":1,"deleted":0,"mode":"100644"}],"worktree":"%s"}\n' "$wt" > "$plan"

probe_cli() {
  rm -f "$probe_dir/report.json" "$wt/canary-marker"
  if ! timeout 120 env \
    QWEN_REVIEW_SANDBOX=tiered \
    QWEN_REVIEW_FORCE_HARDWARE=1 \
    npm_config_offline=true npm_config_audit=false npm_config_fund=false \
    qwen review build-test --plan "$plan" --worktree "$wt" --out "$probe_dir/report.json" --install \
    > "$probe_dir/probe.log" 2>&1; then
    return 1
  fi
  [ -f "$probe_dir/report.json" ] || return 1
  # A silently-downgraded CLI executes the fixture's preinstall.
  [ ! -e "$wt/canary-marker" ] || return 1
  node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const b = r.executionBoundary;
    if (!b || b.policy !== "tiered" || b.executionClass !== "hardware-isolated" || b.backend !== "refused") process.exit(1);
  ' "$probe_dir/report.json"
}

# Surface the probe's own log on refusal so a timeout / crash / missing bundle
# is diagnosable instead of being reported as a bare boundary regression.
refuse() {
  echo "::error::review CLI capability gate: $1"
  echo "--- probe log (tail) ---"
  tail -n 40 "$probe_dir/probe.log" 2>/dev/null || true
  exit 1
}

if probe_cli; then
  echo "Review CLI implements the tiered sandbox boundary (behaviour probe passed)." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi
echo "::warning::the installed review CLI did not confirm the tiered sandbox boundary (probe failed; see log tail on refusal); trying the newest published release into a private prefix."
# Private per-run prefix inside the checkout (reclaimed by the next run's
# checkout clean): never mutate the pool's global npm prefix (R5-1). On a
# successful upgrade the prefix bin must be appended to GITHUB_PATH or the
# review step would still resolve the pool's old CLI.
latest_prefix="$GITHUB_WORKSPACE/.qwen-review-cli-latest"
rm -rf "$latest_prefix"
if npm install --prefix "$latest_prefix" --registry=https://registry.npmjs.org --no-audit --no-fund '@qwen-code/qwen-code@latest'; then
  export PATH="$latest_prefix/node_modules/.bin:$PATH"
  if probe_cli; then
    echo "$latest_prefix/node_modules/.bin" >> "$GITHUB_PATH"
    echo "Review CLI implements the tiered sandbox boundary after published-release upgrade." >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
fi
echo "::warning::no published release confirms the tiered sandbox boundary; building the CLI from the trusted base checkout."
install_attempt=1
while :; do
  if corepack pnpm install --frozen-lockfile --reporter=append-only; then
    break
  fi
  if [ "$install_attempt" -ge 2 ]; then
    refuse "pnpm install of the base checkout failed; refusing to review with an unsupported CLI."
  fi
  find . -name node_modules -type d -prune -exec rm -rf {} +
  install_attempt=$((install_attempt + 1))
done
if ! NODE_OPTIONS=--max-old-space-size=6144 npm run build; then
  refuse "base-checkout build failed; refusing to review with an unsupported CLI."
fi
if ! NODE_OPTIONS=--max-old-space-size=6144 npm run bundle; then
  refuse "base-checkout bundle failed; refusing to review with an unsupported CLI."
fi
# Fixed-name wrapper dir inside the checkout: overwritten on each build, inert
# unless this run appended it to GITHUB_PATH, and reclaimed by the next run's
# checkout clean (actions/checkout clean=true runs git clean -ffdx). GITHUB_PATH
# is appended before any PR code runs and the review agent's own GITHUB_PATH is
# decoyed, so nothing reviewed can steer which CLI the review step resolves.
bin_dir="$GITHUB_WORKSPACE/.qwen-review-cli-bin"
rm -rf "$bin_dir"
mkdir -p "$bin_dir"
printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$GITHUB_WORKSPACE" > "$bin_dir/qwen"
chmod +x "$bin_dir/qwen"
echo "$bin_dir" >> "$GITHUB_PATH"
export PATH="$bin_dir:$PATH"
if ! probe_cli; then
  refuse "the base-checkout build still does not implement the tiered sandbox boundary; refusing to review."
fi
echo "Review CLI implements the tiered sandbox boundary (base-checkout build)." >> "$GITHUB_STEP_SUMMARY"