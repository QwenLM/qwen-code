# Vision Bridge For Text Models Tmux E2E

## Scope

Verify the user-visible interactive path for `visionBridge`: a text-only
primary model receives an image reference, Qwen Code converts it through a
vision model, displays the generated transcription, and sends only text to the
primary model.

This tmux case complements the unit regression for duplicated model ids in
`BaseLlmClient`. The duplicated-provider routing bug is deterministic and is
covered by focused tests; the tmux case verifies the real TUI workflow.

## Prerequisites

- A built local CLI: `npm run build && npm run bundle`.
- A working provider configuration in the normal Qwen home directory.
- Environment variables set for the run:

```bash
export PRIMARY_AUTH_TYPE=openai
export PRIMARY_TEXT_MODEL=deepseek-v3
export BRIDGE_MODEL=qwen3-vl-plus
```

`PRIMARY_TEXT_MODEL` must be text-only. `BRIDGE_MODEL` must be registered in
`modelProviders` or otherwise resolvable by the provider selected for the
session. Leave `BRIDGE_MODEL` empty only when the local provider config already
contains an image-capable model for auto-selection.

## Fixture

Create a temporary project, runtime directory, workspace settings, and an image
fixture with a unique marker:

```bash
ROOT="$(pwd)"
RUN_DIR="/tmp/qwen-vision-bridge-e2e"
PROJECT="$RUN_DIR/project"
RUNTIME="$RUN_DIR/runtime"
CAPTURES="$RUN_DIR/captures"
MARKER="VISION_BRIDGE_E2E_73619"

rm -rf "$RUN_DIR"
mkdir -p "$PROJECT/.qwen" "$RUNTIME" "$CAPTURES"

cat > "$PROJECT/.qwen/settings.json" <<JSON
{
  "visionBridge": {
    "enabled": true,
    "model": "${BRIDGE_MODEL}",
    "maxImages": 2,
    "timeoutMs": 60000,
    "showTranscript": true
  }
}
JSON

python3 - <<'PY'
from pathlib import Path

out = Path("/tmp/qwen-vision-bridge-e2e/project/vision-bridge-fixture.svg")
marker = "VISION_BRIDGE_E2E_73619"
out.write_text(f"""<svg xmlns="http://www.w3.org/2000/svg" width="900" height="320">
  <rect width="900" height="320" fill="white"/>
  <text x="40" y="90" font-size="44" font-family="Arial" fill="black">Qwen Vision Bridge E2E</text>
  <text x="40" y="170" font-size="52" font-family="Arial" fill="black">{marker}</text>
  <text x="40" y="245" font-size="34" font-family="Arial" fill="black">Expected: transcribe this marker exactly.</text>
</svg>
""", encoding="utf-8")
PY
```

If the selected provider does not accept SVG input, replace the fixture with a
PNG screenshot containing the same marker and update the prompt path.

If folder trust is enabled in your user settings, trust `$PROJECT` before the
next step or run this case from an already trusted workspace. Otherwise the
temporary workspace settings and `--approval-mode yolo` may be ignored or
blocked before vision bridge runs.

## Run

Launch the local build in tmux:

```bash
tmux kill-session -t qwen-vision-bridge-e2e 2>/dev/null || true
tmux new-session -d -s qwen-vision-bridge-e2e -x 180 -y 48 \
  "cd '$PROJECT' && QWEN_RUNTIME_DIR='$RUNTIME' node '$ROOT/dist/cli.js' --auth-type '$PRIMARY_AUTH_TYPE' --model '$PRIMARY_TEXT_MODEL' --approval-mode yolo"
sleep 4
tmux capture-pane -t qwen-vision-bridge-e2e -p -S -120 > "$CAPTURES/00-start.txt"
```

Send an image reference:

```bash
tmux send-keys -t qwen-vision-bridge-e2e "@vision-bridge-fixture.svg Please read the marker in this image and answer with only that marker."
sleep 0.5
tmux send-keys -t qwen-vision-bridge-e2e Enter

for i in $(seq 1 90); do
  sleep 2
  tmux capture-pane -t qwen-vision-bridge-e2e -p -S -200 > "$CAPTURES/01-after-prompt.txt"
  grep -q "esc to cancel" "$CAPTURES/01-after-prompt.txt" || break
done
```

Capture final state:

```bash
tmux capture-pane -t qwen-vision-bridge-e2e -p -S -300 > "$CAPTURES/02-final.txt"
tmux kill-session -t qwen-vision-bridge-e2e
```

## Assertions

The final capture must satisfy all of these checks:

```bash
grep -q "Converted 1 image(s) to text via" "$CAPTURES/02-final.txt"
grep -q "BEGIN image interpretation" "$CAPTURES/02-final.txt"
grep -q "$MARKER" "$CAPTURES/02-final.txt"
! grep -qi "image input.*not supported" "$CAPTURES/02-final.txt"
! grep -qi "no image-capable model" "$CAPTURES/02-final.txt"
```

Manual visual checks:

- The conversion notice is visible before or near the final assistant answer.
- The notice discloses the bridge model and, when available, its endpoint.
- The generated interpretation is shown when `showTranscript` is true.
- The assistant answer reflects the marker from the image, not a generic
  unsupported-image response.

## Negative Control

Disable the bridge in the temporary settings:

```bash
perl -0pi -e 's/"enabled": true/"enabled": false/' "$PROJECT/.qwen/settings.json"
```

Repeat the tmux run. Expected:

- No `Converted 1 image(s) to text via` notice.
- The turn follows the normal text-only unsupported-image path.
- The assistant must not infer the marker from the image.

## Evidence To Attach To The PR

Attach or summarize:

- `$CAPTURES/00-start.txt`
- `$CAPTURES/01-after-prompt.txt`
- `$CAPTURES/02-final.txt`
- The exact `PRIMARY_AUTH_TYPE`, `PRIMARY_TEXT_MODEL`, and `BRIDGE_MODEL`
  values used.
- Whether SVG was accepted directly or replaced by a PNG screenshot fixture.

## Local Regression Commands

These deterministic tests cover the provider-routing edge case that tmux cannot
reliably isolate without a custom provider setup:

```bash
npm -w packages/core exec vitest run src/services/visionBridge/visionBridgeService.test.ts
npm -w packages/core exec vitest run src/utils/sideQuery.test.ts src/core/baseLlmClient.test.ts
```
