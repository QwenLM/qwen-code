import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-code-pr-review.yml',
  'utf8',
);

function runReviewStep() {
  const doc = load(workflow);
  const step = doc.jobs['review-pr'].steps.find((s) => s.name === 'Run review');
  return step.run;
}

// Extract the transient-retry loop (run_review_once + the while loop) so the
// real bash is exercised, not a paraphrase.
function retryLoopSource() {
  // js-yaml strips the block scalar's leading indentation, so top-level lines
  // (OUTCOME='' and the while loop's `done`) sit at column 0 — extract between
  // them verbatim and run it as-is.
  const run = runReviewStep();
  const start = run.indexOf("OUTCOME=''");
  const end = run.lastIndexOf('\ndone') + '\ndone'.length;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return run.slice(start, end);
}

// Drive the extracted loop with a stub qwen whose stream-json `result` event is
// scripted per attempt, plus stub timeout/sleep so the test is instant.
function runScenario(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'review-retry-'));
  try {
    const bin = join(dir, 'bin');
    const attemptFile = join(dir, 'attempts');
    writeFileSync(attemptFile, '');
    const write = (name, body) => {
      const p = join(bin, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    };
    execFileSync('mkdir', ['-p', bin]);
    // timeout: drop `--kill-after=Xs` and the duration, exec the rest.
    write('timeout', '#!/bin/bash\nshift\nshift\nexec "$@"\n');
    write('sleep', '#!/bin/bash\nexit 0\n');
    write(
      'qwen',
      [
        '#!/bin/bash',
        'n=$(( $(cat "$ATT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ATT"',
        'r(){ printf \'{"type":"result","subtype":"%s","is_error":%s,"result":"%s"}\\n\' "$1" "$2" "$3"; }',
        'case "$SCENARIO" in',
        '  success) r success false "Reviewed — no blockers." ;;',
        '  transient_then_success) if [ "$n" -eq 1 ]; then r success false "[API Error: 503 upstream overloaded]"; else r success false "ok on retry"; fi ;;',
        '  transient_persist) r success false "[API Error: 503 upstream overloaded]" ;;',
        '  quota) r success false "[API Error: 429 Your token-plan quota has been exhausted. The quota will reset at 07-19 13:17:00 UTC.]" ;;',
        '  errresult) r error true "connection dropped mid-review" ;;',
        '  hardexit) exit 3 ;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    );
    const harness = [
      'set -euo pipefail',
      'QWEN_TIMEOUT=180; MODEL_ARGS=(--model x); PROMPT="/review x"',
      `LOG_PATH="${join(dir, 'log')}"`,
      `GITHUB_OUTPUT="${join(dir, 'gho')}"; GITHUB_STEP_SUMMARY="${join(dir, 'gss')}"`,
      ': > "$GITHUB_OUTPUT"; : > "$GITHUB_STEP_SUMMARY"',
      'fail(){ echo "FAIL kind=[${3:-}] reason=[$1]"; exit "${2:-1}"; }',
      retryLoopSource(),
      'echo "OK outcome=$OUTCOME"',
    ].join('\n');
    let stdout = '';
    try {
      stdout = execFileSync('bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SCENARIO: scenario,
          ATT: attemptFile,
        },
      });
    } catch (e) {
      stdout = `${e.stdout ?? ''}`;
    }
    const line =
      stdout
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('OK ') || l.startsWith('FAIL '))
        .pop() ?? stdout.trim();
    return { line, attempts: Number(readFileSync(attemptFile, 'utf8').trim()) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('qwen pr review transient retry', () => {
  it('does not retry a clean success', () => {
    const r = runScenario('success');
    expect(r.line).toContain('OK outcome=success');
    expect(r.attempts).toBe(1);
  });

  it('retries a transient failure once and succeeds', () => {
    const r = runScenario('transient_then_success');
    expect(r.line).toContain('OK outcome=success');
    expect(r.attempts).toBe(2);
  });

  it('retries a transient failure at most once, then fails', () => {
    const r = runScenario('transient_persist');
    expect(r.line).toContain('FAIL');
    expect(r.line).not.toContain('kind=[quota]');
    expect(r.attempts).toBe(2);
  });

  it('does NOT retry a quota exhaustion and surfaces a quota kind + reset time', () => {
    const r = runScenario('quota');
    expect(r.line).toContain('FAIL kind=[quota]');
    expect(r.line).toContain('reset at 07-19 13:17:00 UTC');
    expect(r.attempts).toBe(1);
  });

  it('retries an aborted (error-result) run', () => {
    const r = runScenario('errresult');
    expect(r.line).toContain('FAIL');
    expect(r.attempts).toBe(2);
  });

  it('does NOT retry a hard non-zero exit', () => {
    const r = runScenario('hardexit');
    expect(r.line).toContain('FAIL');
    expect(r.attempts).toBe(1);
  });

  it('keeps the fallback comment quota-aware', () => {
    const doc = load(workflow);
    const fallback = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Post fallback comment on failure',
    ).run;
    expect(fallback).toContain('"$FAILURE_KIND" = "quota"');
    expect(fallback).toContain('model quota exhausted');
  });
});
