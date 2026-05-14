#!/usr/bin/env bash
# upstream-sync-verify.sh
# Post-merge verification pipeline for upstream sync.
# Checks build, types, tests, and branding integrity.
# Exit code 0 = all checks pass, non-zero = failure.

set -euo pipefail

STEP=0
TOTAL_STEPS=5

fail() {
  echo "FAIL [$STEP/$TOTAL_STEPS]: $1" >&2
  exit 1
}

pass() {
  echo "PASS [$STEP/$TOTAL_STEPS]: $1"
}

# Step 1: Build
STEP=1
echo "[$STEP/$TOTAL_STEPS] Running build..."
npm run build || fail "Build failed"
pass "Build succeeded"

# Step 2: Type check
STEP=2
echo "[$STEP/$TOTAL_STEPS] Running typecheck..."
npm run typecheck || fail "Type check failed"
pass "Type check passed"

# Step 3: Unit tests
STEP=3
echo "[$STEP/$TOTAL_STEPS] Running tests..."
npm run test || fail "Tests failed"
pass "Tests passed"

# Step 4: Lint
STEP=4
echo "[$STEP/$TOTAL_STEPS] Running lint..."
npm run lint || fail "Lint failed"
pass "Lint passed"

# Step 5: Branding integrity check
STEP=5
echo "[$STEP/$TOTAL_STEPS] Checking branding integrity..."

BRANDING_FILES=(
  "packages/cli/src/ui/components/AsciiArt.ts"
  "packages/cli/src/ui/components/Header.tsx"
  "packages/cli/src/ui/components/Tips.tsx"
)

SETTINGS_FILE=".qwen/settings.json"

# Check .qwen/settings.json still has feature flags
if [ -f "$SETTINGS_FILE" ]; then
  if grep -q '"dataworksBranding"' "$SETTINGS_FILE"; then
    pass "Feature flags present in $SETTINGS_FILE"
  else
    fail "Feature flags missing from $SETTINGS_FILE - branding may have been overwritten"
  fi
else
  fail "$SETTINGS_FILE not found - internal settings may have been deleted"
fi

# Check branding files still exist and contain feature flag references
for f in "${BRANDING_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    fail "Branding file $f is missing"
  fi
done

# Check Header.tsx still has the feature flag guard
if grep -q "dataworksBranding" "packages/cli/src/ui/components/Header.tsx"; then
  pass "Header.tsx has feature flag guard"
else
  echo "WARN: Header.tsx may have lost feature flag guard during merge" >&2
fi

pass "Branding integrity verified"

echo ""
echo "All $TOTAL_STEPS verification steps passed."
