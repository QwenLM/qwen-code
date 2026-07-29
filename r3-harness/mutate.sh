#!/bin/bash
# PR #7914 R3 mutation matrix over the new guard + mimeType/kind logic.
# Each mutation must PROVE it landed (diff non-empty) before the run counts.
set -u
SP=/private/tmp/claude-501/-Users-cici-git-qwen-code-x3/b1195e54-3e17-406f-a1ae-99f5266e14df/scratchpad
TREE=$SP/e2e-tree
SRC=$TREE/packages/core/src/tools/write-file.ts
cp "$SRC" "$SP/write-file.pristine.ts"

run_case() {
  local id="$1" desc="$2" py="$3"
  cp "$SP/write-file.pristine.ts" "$SRC"
  python3 - "$SRC" <<PYEOF
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
$py
io.open(p, 'w', encoding='utf-8').write(s)
PYEOF
  if diff -q "$SP/write-file.pristine.ts" "$SRC" >/dev/null; then
    echo "$id | $desc | *** MUTATION DID NOT LAND — result meaningless ***"
    return
  fi
  local out
  out=$(cd "$TREE/packages/core" && ../../node_modules/.bin/vitest run src/tools/write-file.test.ts --reporter=dot 2>&1)
  local line
  line=$(echo "$out" | command grep -oE '[0-9]+ failed \| [0-9]+ passed|Tests +[0-9]+ passed' | head -1)
  if echo "$out" | command grep -q "failed"; then
    local names
    names=$(echo "$out" | command grep -oE "WriteFileTool > [^\n]*" | head -3 | tr '\n' ';')
    echo "$id | $desc | CAUGHT ($line)"
  else
    echo "$id | $desc | SURVIVED ($line)"
  fi
}

echo "=== PR 7914 mutation matrix (write-file.test.ts, 70 tests) ==="
run_case M1 "guard: drop 'title.length > 200'" \
  "s = s.replace('    title.length > 200 ||\n', '')"
run_case M2 "guard: drop 'hasControlCharacter(title)'" \
  "s = s.replace('    hasControlCharacter(title) ||\n', '')"
run_case M3 "guard: drop 'hasUnsafeDisplayPayload(title)'" \
  "s = s.replace('    hasUnsafeDisplayPayload(title) ||\n', '')"
run_case M4 "guard: drop 'workspacePath.length > 500'" \
  "s = s.replace('    workspacePath.length > 500 ||\n', '')"
run_case M5 "guard: drop 'hasControlCharacter(workspacePath)'" \
  "s = s.replace('    hasControlCharacter(workspacePath) ||\n', '')"
run_case M6 "guard: drop 'hasUnsafeDisplayPayload(workspacePath)'" \
  "s = s.replace(' ||\n    hasUnsafeDisplayPayload(workspacePath)\n  ) {', '\n  ) {')"
run_case M7 "mimeType: remove .ipynb fallback" \
  "s = s.replace(\"getSpecificMimeType(filePath) ??\n      (filePath.toLowerCase().endsWith('.ipynb')\n        ? 'application/x-ipynb+json'\n        : undefined),\", 'getSpecificMimeType(filePath),')"
run_case M8 "kind: .htm -> 'file'" \
  "s = s.replace(\"  ['.htm', 'html'],\", \"  ['.htm', 'file'],\")"
run_case M9 "delegation: buildRecordArtifactReminder bypasses the guard" \
  "s = s.replace('  const artifact = buildWorkspaceArtifactMetadata(config, filePath);\n  return artifact ? formatRecordArtifactReminder(artifact.workspacePath) : null;', '  const wp = getRecordArtifactWorkspacePath(config, filePath);\n  return wp ? formatRecordArtifactReminder(wp) : null;')"

cp "$SP/write-file.pristine.ts" "$SRC"
echo "=== source restored ==="
