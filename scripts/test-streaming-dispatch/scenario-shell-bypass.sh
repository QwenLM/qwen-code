#!/usr/bin/env bash
# Scenario 3 — shell-wrapper bypass safety.
#
# We CANNOT safely drive this via an LLM prompt — coaxing the model to
# emit `bash -c "..." && rm -rf /tmp/x` is unreliable and the resulting
# command could actually run if anything in the safety chain is broken.
# Instead we exercise the classifier directly: feed a battery of
# wrapper-with-trailing-content payloads to `isEarlyDispatchSafe()` from
# Node and assert each one classifies as unsafe.
#
# This is the same code path the dispatcher uses on the hot path; if it
# rejects the malicious shapes here, the early-dispatch path can never
# fire on them in production. The matching vitest cases in
# streamingToolDispatcher.test.ts already cover this — this scenario is a
# smoke check that they also hold in the built dist.

set -uo pipefail
source "$(dirname "$0")/lib.sh"

section "Scenario: shell wrapper bypass (classifier-level)"

NODE_SCRIPT="$RESULTS_DIR/shell-bypass.mjs"
CORE_INDEX="$REPO_ROOT/packages/core/dist/src/index.js"
if [[ ! -f "$CORE_INDEX" ]]; then
  echo "FATAL: $CORE_INDEX missing (run 'npm run build')" >&2
  exit 1
fi
cat >"$NODE_SCRIPT" <<'JS'
// Direct unit-style probe of the classifier in the built core package.
// Core index path is provided via argv[2] so the path resolves to the
// repo's dist regardless of where this scratch file ends up living.
const corePath = process.argv[2];
const { isEarlyDispatchSafe } = await import(corePath);

// Minimal stub config — only the bits isEarlyDispatchSafe touches.
const SHELL_NAME = 'run_shell_command';
const config = {
  getToolRegistry: () => ({
    getTool: (name) =>
      name === SHELL_NAME ? { kind: 'execute' } : undefined,
  }),
};

const cases = [
  // [command, expectedSafe, label]
  ['ls',                                                  true,  'plain read-only'],
  ['git log --oneline -n 5',                              true,  'plain git log'],
  // SECURITY: the classifier now refuses early dispatch for ALL wrapper
  // commands (any `bash -c "..."` / `sh -c '...'` shape), even when the
  // wrapper has no trailing content. An earlier positional `lastIndexOf`
  // guard was bypassable via substring collision (e.g. inner command
  // string re-introduced in a trailing destructive payload's URL or
  // comment). Conservative reject-all is the only correct guard until
  // `stripShellWrapper` returns positional metadata; the post-stream
  // permission path still runs these normally with proper AST analysis.
  ['ls',                                                  true,  'plain read-only no wrapper'],
  ['git log --oneline -n 5',                              true,  'plain git log no wrapper'],
  ['bash -c "ls"',                                        false, 'plain wrapper now rejected'],
  ['sh -c \'grep foo bar\'',                              false, 'single-quoted plain wrapper'],
  ['bash -c "cat x" && rm -rf /tmp/junk',                 false, '&& side-effect after wrapper'],
  ['bash -c "ls" | tee /tmp/out',                         false, '| pipe after wrapper'],
  ['sh -c "grep foo bar" ; chmod -R 777 /tmp',            false, '; chmod after wrapper'],
  ['bash -c "git log" ; git push --force',                false, '; git push --force after wrapper'],
  ['sh -c \'ls\' && rm -rf /tmp/junk',                    false, '&& after single-quoted'],
  // Substring-collision bypasses the prior guard admitted (the inner
  // command's text appears in the trailing payload, fooling
  // `lastIndexOf` into reading the wrong end-of-stripped position).
  ['bash -c "ls" && rm -rf / && ls',                      false, 'ls echoed after destructive &&'],
  ['bash -c "echo safe" ; rm -rf / # echo safe',          false, 'inner string in # comment'],
  ['rm -rf node_modules',                                 false, 'bare destructive'],
];

let pass = 0, fail = 0;
const rows = [];
for (const [cmd, expectedSafe, label] of cases) {
  // Match Kind.Execute path: tool with kind === 'execute'.
  // ToolNames canonicalization happens inside isEarlyDispatchSafe via
  // ToolNamesMigration; we use the canonical name directly.
  const req = {
    callId: 'c',
    name: SHELL_NAME,
    args: { command: cmd },
    isClientInitiated: false,
    prompt_id: 'p',
  };
  let got;
  try {
    got = isEarlyDispatchSafe(config, req);
  } catch (e) {
    got = `THREW: ${e.message}`;
  }
  const ok = got === expectedSafe;
  rows.push({ label, cmd, expected: expectedSafe, got, ok });
  if (ok) pass++; else fail++;
}

for (const r of rows) {
  const tag = r.ok ? 'PASS' : 'FAIL';
  console.log(`${tag}\texpected=${r.expected}\tgot=${r.got}\t${r.label}\t::${r.cmd}::`);
}
console.log(`\nSUMMARY: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
JS

stdout="$RESULTS_DIR/shell-bypass.stdout"
stderr="$RESULTS_DIR/shell-bypass.stderr"
node "$NODE_SCRIPT" "$CORE_INDEX" >"$stdout" 2>"$stderr"
rc=$?

cat "$stdout"
if [[ $rc -ne 0 ]]; then
  echo "FAIL: shell-bypass classifier rejected at least one expected case"
  cat "$stderr" >&2
fi

{
  echo "scenario=shell-bypass"
  echo "exit_code=$rc"
  grep -c '^PASS' "$stdout" | awk '{print "pass="$1}'
  grep -c '^FAIL' "$stdout" | awk '{print "fail="$1}'
} > "$RESULTS_DIR/shell-bypass-summary.txt"

section "Shell bypass summary"
cat "$RESULTS_DIR/shell-bypass-summary.txt"
exit $rc
