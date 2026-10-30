#!/usr/bin/env bash
# Fail fast when a self-hosted pool host does not render text like the x64
# baseline the web-shell layout assertions were written against.
#
# Why this exists: the web-shell smoke suite asserts exact text layout (for
# example that the token-usage header wraps at the 320 px panel minimum). Type
# metrics feed those assertions directly. A host whose default sans-serif
# resolves to WenQuanYi Zen Hei instead of DejaVu Sans measures the same
# strings ~26 px narrower, so the wrap never happens and the assertion fails
# 26 minutes into the suite with nothing in the log pointing at fonts (#15383).
#
# Two checks:
#   L0  fontconfig's default sans-serif family        (always)
#   L1  text advance widths in the pinned Chromium    (--with-metrics)
#
# Usage: check-font-baseline.sh [--with-metrics]
# Exit: 0 = matches the baseline, 1 = drift or missing prerequisite,
#       2 = usage error.
set -uo pipefail

EXPECTED_FAMILY="${QWEN_CI_FONT_FAMILY:-DejaVu Sans}"
# The three hero text runs whose combined width decides whether the token-usage
# header wraps at the 320 px panel minimum. Measured on the x64 ECS pool
# (ecs-qwen-hk2: DejaVu Sans for Latin, WenQuanYi for CJK) in the Playwright
# Chromium the suite itself uses, at this scenario's fixed content:
#   value   formatCompact(grandTotal) for the mock's 19.99M total
#   label   i18n tokenUsage.total (zh-CN)
#   updated i18n tokenUsage.updatedAt with the spec's clock fixed to
#           11:49:29Z and the browser's en-US locale
# Re-measure on a host known to match the pool by running this script with
# --with-metrics and copying the printed numbers back here.
EXPECTED_VALUE="${QWEN_CI_FONT_METRIC_VALUE:-113.08}"
EXPECTED_LABEL="${QWEN_CI_FONT_METRIC_LABEL:-49.97}"
EXPECTED_UPDATED="${QWEN_CI_FONT_METRIC_UPDATED:-106.42}"
TOLERANCE="${QWEN_CI_FONT_METRIC_TOLERANCE:-0.5}"

with_metrics=0
case "${1:-}" in
  '') ;;
  --with-metrics) with_metrics=1 ;;
  -h | --help)
    echo 'Usage: check-font-baseline.sh [--with-metrics]'
    exit 0
    ;;
  *)
    echo "Unknown argument: ${1}" >&2
    exit 2
    ;;
esac

annotate() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error::$*"
  else
    echo "error: $*" >&2
  fi
}

# L0 — the family every `sans-serif` request resolves to.
if ! command -v fc-match >/dev/null 2>&1; then
  annotate 'fc-match is unavailable; this host needs fontconfig'
  exit 1
fi
family_match=$(fc-match -f '%{family}' sans-serif 2>/dev/null)
if [ -z "${family_match}" ]; then
  annotate 'fc-match returned no default sans-serif family'
  exit 1
fi
case "${family_match}" in
  *"${EXPECTED_FAMILY}"*)
    echo "font baseline: default sans-serif = ${family_match}"
    ;;
  *)
    annotate "default sans-serif is '${family_match}', expected '${EXPECTED_FAMILY}'. Install fonts-dejavu-core on this host; see .github/scripts/ecs-runner/README.md."
    exit 1
    ;;
esac

if [ "${with_metrics}" -eq 0 ]; then
  exit 0
fi

# L1 — actual advance widths in the browser the suite runs.
chromium="${CHROMIUM_BIN:-}"
if [ -z "${chromium}" ]; then
  for candidate in \
    "${HOME:-/root}"/.cache/ms-playwright/chromium_headless_shell-*/*/headless_shell \
    "${HOME:-/root}"/.cache/ms-playwright/chromium-*/*/chrome; do
    if [ -x "${candidate}" ]; then
      chromium="${candidate}"
      break
    fi
  done
fi
if [ -z "${chromium}" ] || [ ! -x "${chromium}" ]; then
  echo 'font metrics: skipped (no Playwright Chromium on this host; set CHROMIUM_BIN to force)'
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'font metrics: skipped (node is unavailable to parse the probe result)'
  exit 0
fi

probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/qwen-font-probe.XXXXXX") || {
  annotate 'could not create a temporary directory for the font probe'
  exit 1
}
trap 'rm -rf "${probe_dir}"' EXIT

cat >"${probe_dir}/probe.html" <<'PROBE'
<!doctype html>
<html><head><meta charset="utf-8"><title>pending</title></head><body><script>
const FAM = "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif";
function width(text, size, weight, extra) {
  const span = document.createElement('span');
  span.textContent = text;
  span.style.cssText = 'font-family:' + FAM + ';font-size:' + size + 'px;font-weight:' + weight + ';white-space:pre;position:absolute;left:-9999px';
  for (const key in extra || {}) span.style[key] = extra[key];
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return +width.toFixed(2);
}
document.title = JSON.stringify({
  value: width('19.99M', 28, 700, { fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }),
  label: width('总 Token', 12, 400),
  updated: width('更新于 11:49:29 AM', 11, 400, { fontVariantNumeric: 'tabular-nums' }),
});
</script></body></html>
PROBE

probe_args=(--headless --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir="${probe_dir}/profile")
if command -v timeout >/dev/null 2>&1; then
  dom=$(timeout 120 "${chromium}" "${probe_args[@]}" --dump-dom "file://${probe_dir}/probe.html" 2>/dev/null)
else
  dom=$("${chromium}" "${probe_args[@]}" --dump-dom "file://${probe_dir}/probe.html" 2>/dev/null)
fi
measured=$(printf '%s' "${dom}" | sed -n 's|.*<title>\(.*\)</title>.*|\1|p' | head -1)
if [ -z "${measured}" ] || [ "${measured}" = pending ]; then
  annotate 'the font probe produced no measurements; Chromium could not render the page'
  exit 1
fi

metrics_output=$(
  QWEN_PROBE_JSON="${measured}" \
    QWEN_EXPECT_VALUE="${EXPECTED_VALUE}" QWEN_EXPECT_LABEL="${EXPECTED_LABEL}" \
    QWEN_EXPECT_UPDATED="${EXPECTED_UPDATED}" \
    QWEN_EXPECT_TOLERANCE="${TOLERANCE}" \
    node -e '
      const measured = JSON.parse(process.env.QWEN_PROBE_JSON);
      const tolerance = Number(process.env.QWEN_EXPECT_TOLERANCE);
      const expected = {
        value: Number(process.env.QWEN_EXPECT_VALUE),
        label: Number(process.env.QWEN_EXPECT_LABEL),
        updated: Number(process.env.QWEN_EXPECT_UPDATED),
      };
      const summary = Object.keys(expected)
        .map((key) => key + "=" + measured[key] + " (want " + expected[key] + ")")
        .join(" ");
      const drifted = Object.keys(expected).filter(
        (key) => Math.abs(measured[key] - expected[key]) > tolerance,
      );
      if (drifted.length > 0) {
        console.error("font metrics drifted: " + summary);
        process.exit(1);
      }
      console.log("font baseline: metrics match " + summary);
    '
)
status=$?
if [ "${status}" -ne 0 ]; then
  printf '%s\n' "${metrics_output}" >&2
  annotate "text metrics in Chromium do not match the x64 baseline (tolerance ${TOLERANCE}px); this host's font stack differs from the pool baseline"
  exit 1
fi
printf '%s\n' "${metrics_output}"
exit 0
