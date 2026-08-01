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
    const durationFile = join(dir, 'durations');
    writeFileSync(attemptFile, '');
    writeFileSync(durationFile, '');
    const write = (name, body) => {
      const p = join(bin, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    };
    execFileSync('mkdir', ['-p', bin]);
    // timeout: record the per-attempt duration (`$2`, e.g. `10800s`) so tests
    // can assert the budget each attempt was given, then drop
    // `--kill-after=Xs` and that duration and exec the rest.
    write(
      'timeout',
      '#!/bin/bash\necho "$2" >> "$DUR"\nif [ "${SCENARIO:-}" = "timeout_kill" ]; then exit 124; fi\nshift\nshift\nexec "$@"\n',
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
        '  abort_no_status) r success false "[API Error: Connection error.]" ;;',
        '  abort_status_suffix) r success false "[API Error: Rate limit exceeded (Status: RESOURCE_EXHAUSTED)]" ;;',
        '  abort_long_body) EPAD=$(printf "A%.0s" $(seq 1 750)); r success false "[API Error: upstream returned an unparseable error body: ${EPAD}]" ;;',
        '  abort_appended) r success false "Partial review text streamed before the connection dropped.[API Error: Connection error.]" ;;',
        '  abort_appended_long) EPAD=$(printf "A%.0s" $(seq 1 750)); r success false "Partial review text streamed before the error.[API Error: upstream returned an unparseable error body: ${EPAD}]" ;;',
        '  abort_with_suffix) r success false "[API Error: Rate limit exceeded]\\nPossible quota limitations in place or slow response times detected. Please wait and try again later." ;;',
        '  success_mentions_api_error) PAD=$(printf "x%.0s" $(seq 1 600)); r success false "This PR detects the [API Error: ...] pattern and routes to retry. quota and rate.?limit keywords cover the common messages. ${PAD} Review complete: COMMENT posted (0 Critical, 1 Suggestion inline)." ;;',
        '  success_quotes_status_code) PAD=$(printf "x%.0s" $(seq 1 700)); r success false "This PR adds retry for [API Error: 429 quota exceeded] and similar. ${PAD} Verdict: COMMENT, 0 Critical." ;;',
        '  success_ends_with_bracket) r success false "Review of [API Error: 429 quota exhausted] handling. Checklist: - [x]" ;;',
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
          DUR: durationFile,
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
    const durations = readFileSync(durationFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((d) => Number.parseInt(d, 10));
    return {
      line,
      attempts: Number(readFileSync(attemptFile, 'utf8').trim()),
      durations,
    };
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

  it('retries an abort with no status code in the message', () => {
    const r = runScenario('abort_no_status');
    expect(r.line).toContain('FAIL');
    expect(r.line).not.toContain('kind=[quota]');
    expect(r.attempts).toBe(2);
  });

  it('retries an abort with status at the end (Status: …) shape', () => {
    const r = runScenario('abort_status_suffix');
    expect(r.line).toContain('FAIL');
    expect(r.line).not.toContain('kind=[quota]');
    expect(r.attempts).toBe(2);
  });

  it('detects an abort whose error body exceeds the 600-byte tail window', () => {
    const r = runScenario('abort_long_body');
    expect(r.line).toContain('FAIL');
    expect(r.line).not.toContain('kind=[quota]');
    expect(r.attempts).toBe(2);
  });

  it('detects the production abort shape: error appended to partial review', () => {
    // BaseJsonOutputAdapter appendText puts the error last, after any
    // partial review text the model already streamed.
    const r = runScenario('abort_appended');
    expect(r.line).toContain('FAIL');
    expect(r.line).not.toContain('kind=[quota]');
    expect(r.attempts).toBe(2);
  });

  it('detects a long error appended to partial review (exceeds any fixed window)', () => {
    const r = runScenario('abort_appended_long');
    expect(r.line).toContain('FAIL');
    expect(r.line).not.toContain('kind=[quota]');
    expect(r.attempts).toBe(2);
  });

  it('detects an abort with a rate-limit guidance suffix after the ]', () => {
    // "Rate limit exceeded" + "quota limitations" in the suffix → quota
    // bucket → no retry (1 attempt).
    const r = runScenario('abort_with_suffix');
    expect(r.line).toContain('FAIL kind=[quota]');
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

  it('does NOT misclassify prose quoting a real status code mid-body', () => {
    // A long review (>600 bytes) that quotes "[API Error: 429 quota
    // exceeded]" early in the body must not trip the tail-anchored detector.
    const r = runScenario('success_quotes_status_code');
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

  it('gives the retry the remaining budget, not a fixed cap', () => {
    // A retry re-runs the whole review from scratch, so the 300s cap this
    // replaced killed it mid-preamble on any large PR and reported a timeout.
    // The stub timeout used to discard the duration argument, so no test
    // observed what each attempt was actually given: reintroducing a cap here
    // would leave the suite green while making every retry unusable again.
    const r = runScenario('transient_then_success');
    expect(r.attempts).toBe(2);
    expect(r.durations).toHaveLength(2);
    expect(r.durations[0]).toBeGreaterThan(10_000); // ~10800s == 180min budget
    expect(r.durations[1]).toBeGreaterThan(300); // the cap this replaced
    expect(r.durations[1]).toBeGreaterThan(10_000); // the rest of the budget
    // Attempts share one budget, so the retry can never exceed what is left.
    expect(r.durations[1]).toBeLessThanOrEqual(r.durations[0]);
  });

  it('does NOT start a retry that the remaining budget cannot finish', () => {
    // 8min budget: over the old 360s gate, under the current 660s one. Pins
    // the gate — dropping RETRY_MIN_SECONDS back to the old cap would retry
    // here into a review that cannot complete.
    const r = runScenario('transient_then_success', { timeoutMinutes: 8 });
    expect(r.line).toContain('FAIL');
    expect(r.line).not.toContain('kind=[timeout]'); // reports the transient
    expect(r.attempts).toBe(1);
  });

  it('still retries once the remaining budget clears the gate', () => {
    // 12min budget, just over the 660s gate: the other side of the boundary,
    // so a RETRY_MIN_SECONDS raised too far cannot pass unnoticed.
    const r = runScenario('transient_then_success', { timeoutMinutes: 12 });
    expect(r.line).toContain('OK outcome=success');
    expect(r.attempts).toBe(2);
  });

  it('keeps the fallback comment quota-aware', () => {
    const doc = parse(workflow);
    const fallback = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Post fallback comment on failure',
    ).run;
    expect(fallback).toContain('"$FAILURE_KIND" = "quota"');
    expect(fallback).toContain('model quota exhausted');
  });

  it('keeps the workflow rate-limit suffix list in sync with errorParsing.ts', () => {
    const src = readFileSync('packages/core/src/utils/errorParsing.ts', 'utf8');
    const blk = src.slice(
      src.indexOf('RATE_LIMIT_MESSAGE_BY_AUTH = {'),
      src.indexOf('} as const;'),
    );
    const suffixes = [...blk.matchAll(/'\\n([^']+)'/g)].map((m) => m[1]);
    expect(suffixes).toHaveLength(3);
    for (const s of suffixes) expect(workflow).toContain(s);
  });

  // Known limitation: a successful review that quotes "[API Error: …]" and
  // ends with "]" (e.g. a "- [x]" checklist or a "[1]" ref link) trips the
  // ends-with gate. The current review template ends with </details> + a
  // <sub> footer, which accidentally protects us. Accepted trade-off; the
  // durable fix is checking that the bot comment actually landed (§5).
  it('KNOWN: prose ending with ] after quoting the pattern is a false positive', () => {
    const r = runScenario('success_ends_with_bracket');
    expect(r.line).toContain('FAIL kind=[quota]');
    expect(r.attempts).toBe(1);
  });
});

// --- Install or update Qwen CLI step ---------------------------------------
// The upgrade step ships several bash branches (already-latest skip,
// registry-unreachable with/without an installed qwen, the sudo-then-
// unprivileged install fallback, both-fail with/without an installed qwen, the
// not-on-PATH error, and the version-shadowing warning). Extract the real `run`
// block — the way retryLoopSource() does for the review loop — and drive each
// branch against stubbed qwen/npm/sudo/timeout binaries, so a future edit that
// breaks the `[ "$have" = "$want" ]` comparison (or a format drift between
// `qwen --version` and `npm view … version`) cannot silently reinstall every
// run, or never upgrade a stale host, with the suite green.

function installStepSource() {
  const doc = parse(workflow);
  const step = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Install or update Qwen CLI',
  );
  return step.run;
}

// Drive the extracted install/update step. `registry` is what `npm view`
// resolves for latest ('' = registry unreachable); `initial` is the version the
// host's pre-installed qwen reports ('' = none, which the step observes as an
// empty `have`); `mode` scripts the install outcome. Returns the step's stdout,
// exit status, and the qwen version resolvable on PATH afterwards.
function runInstallStep({ registry = '', initial = '', mode = 'ok' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-install-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    const stateFile = join(dir, 'qwen-state');
    writeFileSync(stateFile, initial);
    const write = (name, body) => {
      const p = join(bin, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    };
    // qwen --version reports whatever is currently resolvable on PATH.
    write(
      'qwen',
      '#!/bin/bash\nif [ "$1" = "--version" ]; then cat "$QWEN_STATE" 2>/dev/null || true; fi\nexit 0\n',
    );
    // npm: `view` resolves latest (fails when the registry is unreachable);
    // `install` scripts the upgrade outcome and, on a real success, writes the
    // requested version into the PATH state.
    write(
      'npm',
      [
        '#!/bin/bash',
        'sub=""',
        'for a in "$@"; do case "$a" in view) sub=view ;; install) sub=install ;; esac; done',
        'if [ "$sub" = "view" ]; then',
        '  if [ -z "$REGISTRY_VERSION" ]; then exit 1; fi',
        '  printf "%s\\n" "$REGISTRY_VERSION"',
        '  exit 0',
        'fi',
        'case "$INSTALL_MODE" in',
        '  both_fail) exit 1 ;;',
        '  shadow) exit 0 ;;',
        '  not_on_path) : > "$QWEN_STATE"; exit 0 ;;',
        'esac',
        'ver=""',
        'for a in "$@"; do case "$a" in *@qwen-code/qwen-code@*) ver="${a##*@}" ;; esac; done',
        'printf "%s" "$ver" > "$QWEN_STATE"',
        'exit 0',
      ].join('\n') + '\n',
    );
    // sudo wraps the privileged install; fail it to force the unprivileged
    // fallback, otherwise drop `-n` and exec the rest.
    write(
      'sudo',
      '#!/bin/bash\nif [ "$INSTALL_MODE" = "sudo_fail_unpriv_ok" ]; then exit 1; fi\nshift\nexec "$@"\n',
    );
    // timeout <dur> <cmd...>: drop the duration, run the command.
    write('timeout', '#!/bin/bash\nshift\nexec "$@"\n');

    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync('bash', ['-c', installStepSource()], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          QWEN_STATE: stateFile,
          REGISTRY_VERSION: registry,
          INSTALL_MODE: mode,
        },
      });
    } catch (e) {
      stdout = `${e.stdout ?? ''}`;
      status = e.status ?? 1;
    }
    return { stdout, status, state: readFileSync(stateFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('qwen pr review cli install/update', () => {
  it('skips the install entirely when the host already has latest', () => {
    const r = runInstallStep({ registry: '0.21.0', initial: '0.21.0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('qwen 0.21.0 (latest)');
    expect(r.stdout).not.toContain('::warning::');
    expect(r.stdout).not.toContain('::error::');
    expect(r.state).toBe('0.21.0');
  });

  it('reviews with the installed qwen when the registry is unreachable', () => {
    const r = runInstallStep({ registry: '', initial: '0.20.0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      '::warning::npm registry unreachable; reviewing with installed qwen 0.20.0',
    );
    expect(r.state).toBe('0.20.0');
  });

  it('fails when the registry is unreachable and no qwen is installed', () => {
    const r = runInstallStep({ registry: '', initial: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      '::error::qwen is not installed and the npm registry is unreachable',
    );
  });

  it('upgrades a stale host via the privileged install', () => {
    const r = runInstallStep({
      registry: '0.21.0',
      initial: '0.20.0',
      mode: 'ok',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('qwen 0.21.0');
    expect(r.stdout).not.toContain('::warning::');
    expect(r.stdout).not.toContain('::error::');
    expect(r.state).toBe('0.21.0');
  });

  it('falls back to an unprivileged install when sudo is unavailable', () => {
    const r = runInstallStep({
      registry: '0.21.0',
      initial: '0.20.0',
      mode: 'sudo_fail_unpriv_ok',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('qwen 0.21.0');
    expect(r.state).toBe('0.21.0');
  });

  it('reviews with the installed qwen when every install fails', () => {
    const r = runInstallStep({
      registry: '0.21.0',
      initial: '0.20.0',
      mode: 'both_fail',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      '::warning::upgrade to qwen 0.21.0 failed; reviewing with installed qwen 0.20.0',
    );
    expect(r.state).toBe('0.20.0');
  });

  it('fails when every install fails and no qwen is installed', () => {
    const r = runInstallStep({
      registry: '0.21.0',
      initial: '',
      mode: 'both_fail',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      '::error::qwen is not installed and installing 0.21.0 failed',
    );
  });

  it('fails when the install succeeds but qwen is not resolvable on PATH', () => {
    const r = runInstallStep({
      registry: '0.21.0',
      initial: '0.20.0',
      mode: 'not_on_path',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      '::error::qwen 0.21.0 installed but not resolvable on PATH',
    );
  });

  it('warns when a system-wide install shadows the per-run upgrade', () => {
    const r = runInstallStep({
      registry: '0.21.0',
      initial: '0.20.0',
      mode: 'shadow',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('qwen 0.20.0');
    expect(r.stdout).toContain(
      '::warning::wanted qwen 0.21.0 but PATH resolves 0.20.0',
    );
    expect(r.stdout).toContain('shadows the per-run upgrade');
  });
});
