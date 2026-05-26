#!/usr/bin/env bash
# Scenario 2 — --json-schema mode must disable the dispatcher entirely
# (sibling-suppression for structured_output is unsafe to bypass mid-stream;
# see RFC §3.5 and the gate in nonInteractiveCli.ts:837-841).
#
# Verification: with the flag ON + --json-schema, the run should behave
# exactly like flag-off — same exit code, valid JSON object output, no
# early-dispatch side-effects. We can't directly observe "dispatcher not
# constructed" from outside the process, but if the json-schema gate broke
# we'd see either malformed JSON output or an unhandled tool-call response.

set -uo pipefail
source "$(dirname "$0")/lib.sh"

RUNS="${RUNS:-3}"
SCHEMA="$RESULTS_DIR/schema.json"
cat >"$SCHEMA" <<'JSON'
{
  "type": "object",
  "required": ["dispatcher_purpose", "files_listed_sample"],
  "properties": {
    "dispatcher_purpose": {
      "type": "string",
      "description": "One-sentence summary of what StreamingToolDispatcher does."
    },
    "files_listed_sample": {
      "type": "array",
      "items": { "type": "string" },
      "description": "First 3 entries from the packages/core/src/utils listing."
    }
  },
  "additionalProperties": false
}
JSON

PROMPT='Read packages/core/src/core/streamingToolDispatcher.ts header, then list packages/core/src/utils via a glob. Return the structured_output with a one-sentence purpose summary and the first 3 entries of the listing.'

section "Scenario: --json-schema (RUNS=$RUNS)"

for i in $(seq 1 "$RUNS"); do
  echo
  echo "[json-schema] run $i/$RUNS — flag OFF"
  run_cli_once "json-off-$i" "$PROMPT" off "--json-schema @$SCHEMA" || echo "  exit non-zero"
  echo "  wall=$(cat "$RESULTS_DIR/json-off-$i.time")s"

  echo "[json-schema] run $i/$RUNS — flag ON"
  run_cli_once "json-on-$i" "$PROMPT" on "--json-schema @$SCHEMA" || echo "  exit non-zero"
  echo "  wall=$(cat "$RESULTS_DIR/json-on-$i.time")s"
done

# Assert: every run's stdout parses as the schema-conformant object.
pass=0; fail=0
for f in "$RESULTS_DIR"/json-{off,on}-*.stdout; do
  if python3 -c "
import json, sys
try:
    obj = json.load(open('$f'))
except Exception as e:
    print('NOT JSON:', e); sys.exit(1)
if not isinstance(obj, dict):
    print('not object'); sys.exit(1)
if 'dispatcher_purpose' not in obj or 'files_listed_sample' not in obj:
    print('missing required keys:', list(obj.keys())); sys.exit(1)
print('ok')
" >/dev/null 2>&1; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
    echo "FAIL schema check: $f"
    python3 -c "import json; print(json.dumps(json.load(open('$f')), indent=2))" 2>&1 | head -10 || head -20 "$f"
  fi
done

{
  echo "scenario=json-schema"
  echo "runs=$RUNS"
  echo "schema_pass=$pass"
  echo "schema_fail=$fail"
} > "$RESULTS_DIR/json-schema-summary.txt"

section "JSON-schema summary"
cat "$RESULTS_DIR/json-schema-summary.txt"
