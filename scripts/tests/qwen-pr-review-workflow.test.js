/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
import { parse } from 'yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-code-pr-review.yml',
  'utf8',
);

function runReviewStep() {
  const doc = parse(workflow);
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
  // Anchor the end on the retry loop's own budget comment, then its `done` —
  // `lastIndexOf('\ndone')` would silently drift to any later loop added to
  // this run block.
  const budget = run.indexOf('# Retry budget:');
  expect(budget).toBeGreaterThan(start);
  const end = run.indexOf('\ndone', budget) + '\ndone'.length;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return run.slice(start, end);
}

// Drive the extracted loop with a stub qwen whose stream-json `result` event is
// scripted per attempt, plus stub timeout/sleep so the test is instant.
function runScenario(scenario, { timeoutMinutes = 180 } = {}) {
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
    write(
      'timeout',
      '#!/bin/bash\nif [ "${SCENARIO:-}" = "timeout_kill" ]; then exit 124; fi\nshift\nshift\nexec "$@"\n',
    );
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
        '  quota_noreset) r success false "[API Error: 429 Your quota has been exhausted.]" ;;',
        '  success_mentions_api_error) r success false "Review of [API Error: ...] handling — quota and rate.?limit keywords look correct." ;;',
        '  errresult) r error true "connection dropped mid-review" ;;',
        '  hardexit) exit 3 ;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    );
    const harness = [
      'set -euo pipefail',
      `QWEN_TIMEOUT=${timeoutMinutes}; MODEL_ARGS=(--model x); PROMPT="/review x"`,
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

  it('classifies a quota error with NO reset time without dying — the unguarded grep killed the step here', () => {
    // `grep -oiE 'reset at …'` finds nothing, exits 1, and under
    // `set -euo pipefail` the bare assignment aborted the script before
    // fail() ran: no failure_kind, no quota-aware fallback comment.
    const r = runScenario('quota_noreset');
    expect(r.line).toContain('FAIL kind=[quota]');
    expect(r.line).not.toContain('reset at');
    expect(r.attempts).toBe(1);
  });

  it('does NOT misclassify a successful review that mentions [API Error: ...] in its summary', () => {
    // A review of PR #7247 (API error retry) quoted "[API Error: ...]" and
    // "quota … limit" in its result text. The old pattern *"[API Error"*
    // matched the prose and the quota grep hit "quota … limit", falsely
    // reporting quota exhaustion on a successful review.
    const r = runScenario('success_mentions_api_error');
    expect(r.line).toContain('OK outcome=success');
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

  it('does NOT retry a real timeout, and names the attempt that timed out', () => {
    // The stub timeout execs the child unconditionally before this scenario
    // existed, so exit 124 -> OUTCOME='timeout' was never exercised: a
    // regression adding `timeout` to the retryable set would burn a 5-minute
    // retry on a genuinely timed-out review with the suite green.
    const r = runScenario('timeout_kill');
    expect(r.line).toContain('FAIL kind=[timeout]');
    expect(r.line).toContain('seconds (of the 180-minute budget)');
    expect(r.attempts).toBe(0); // qwen never ran; timeout killed the attempt
  });

  it('refuses to start an attempt with under 30s of budget', () => {
    // QWEN_TIMEOUT=0 -> the guard fires before any qwen run: without it the
    // workflow would start a run with seconds of budget, an immediate timeout
    // on a wasted runner slot.
    const r = runScenario('success', { timeoutMinutes: 0 });
    expect(r.line).toContain('FAIL');
    expect(r.line).toContain('ran out of time budget');
    expect(r.attempts).toBe(0);
  });

  it('keeps the fallback comment quota-aware', () => {
    const doc = parse(workflow);
    const fallback = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Post fallback comment on failure',
    ).run;
    expect(fallback).toContain('"$FAILURE_KIND" = "quota"');
    expect(fallback).toContain('model quota exhausted');
  });
});
