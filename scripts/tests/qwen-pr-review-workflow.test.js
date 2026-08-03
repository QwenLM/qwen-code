/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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

// The capture-tools install step's contract is "never fails the review":
// every guard below is load-bearing under the runner's default `bash -e`,
// and this harness exists precisely because an unguarded command under
// `set -e` already killed a step of this workflow once. Extract the step's
// REAL bash and run it against stubbed binaries.
function captureToolsSource() {
  const doc = parse(workflow);
  const step = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Install capture tools (tmux + freeze)',
  );
  expect(step).toBeDefined();
  // The YAML half of the never-fails promise.
  expect(step['continue-on-error']).toBe(true);
  return { run: step.run, env: step.env };
}

// The download half of the happy path: a curl that satisfies `-o <out>` with
// an empty body, and a tar that "extracts" a runnable freeze stub. Shared by
// the scenarios that vary only the verify/install half.
const okCurlStub = [
  'out=""; prev=""',
  'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
  '[ -n "$out" ] && : > "$out"',
  'exit 0',
].join('\n');
const okTarStub = [
  'dest=""; prev=""',
  'for a in "$@"; do [ "$prev" = "-C" ] && dest="$a"; prev="$a"; done',
  'mkdir -p "$dest/freeze_x"',
  'printf \'#!/bin/bash\\necho "freeze ${FREEZE_VERSION}"\\n\' > "$dest/freeze_x/freeze"',
  'chmod +x "$dest/freeze_x/freeze"',
].join('\n');

function runCaptureToolsStep({ stubs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-tools-'));
  try {
    const bin = join(dir, 'bin');
    const homeDir = join(dir, 'home');
    const ghPath = join(dir, 'github_path');
    const calls = join(dir, 'calls');
    execFileSync('mkdir', ['-p', bin, homeDir]);
    writeFileSync(ghPath, '');
    writeFileSync(calls, '');
    const write = (name, body) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "$CALLS"\n${body}\n`);
      chmodSync(p, 0o755);
    };
    // Default stub world: Linux x86_64, sudo present but NOT passwordless
    // (also keeps a developer's real sudo from ever running during tests),
    // broken apt, dead network, rejecting checksum — the WORST runner. Tests
    // override per scenario.
    write('uname', 'echo "Linux x86_64"');
    write('sudo', 'exit 1');
    // Shadow any REAL freeze on the developer's PATH: a stub that fails the
    // version probe forces the download path deterministically.
    write('freeze', 'exit 1');
    write('curl', 'exit 22');
    write('sha256sum', 'exit 1');
    write('apt-get', 'exit 100');
    for (const [name, body] of Object.entries(stubs)) {
      write(name, body);
    }
    const { run, env } = captureToolsSource();
    // Hide the host's tmux so whether the step's apt branch runs depends on
    // the scenario, not on the machine hosting the suite. Blank ONLY the tmux
    // entry, never its directory: on GitHub-hosted ubuntu runners tmux lives
    // in /usr/bin, and dropping the whole directory takes bash, grep, and tar
    // down with it — every test below then died on ENOENT in CI while passing
    // on tmux-less dev machines.
    let shadowSeq = 0;
    const hostPath = (process.env.PATH ?? '')
      .split(':')
      .map((d) => {
        if (!d || !existsSync(join(d, 'tmux'))) return d;
        const shadow = join(dir, `shadow-${shadowSeq++}`);
        mkdirSync(shadow);
        for (const name of readdirSync(d)) {
          if (name === 'tmux') continue;
          try {
            symlinkSync(join(d, name), join(shadow, name));
          } catch {
            // An unreadable or racing entry stays unresolved, same as a host
            // PATH entry the harness could never see.
          }
        }
        return shadow;
      })
      .filter(Boolean)
      .join(':');
    const harness = [
      `export HOME="${homeDir}"`,
      `export GITHUB_PATH="${ghPath}"`,
      `export CALLS="${calls}"`,
      `export FREEZE_VERSION="${env.FREEZE_VERSION}"`,
      `export FREEZE_SHA256="${env.FREEZE_SHA256}"`,
      run,
    ].join('\n');
    let status = 0;
    let stdout = '';
    try {
      // `bash -e -o pipefail` mirrors the runner's default shell for `run:`
      // blocks — the exact mode under which one unguarded failure kills a step.
      stdout = execFileSync('bash', ['-e', '-o', 'pipefail', '-c', harness], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${hostPath}` },
      });
    } catch (e) {
      status = e.status ?? 1;
      stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    const freezePath = join(homeDir, '.qwen-review-tools/bin/freeze');
    return {
      status,
      stdout,
      freezeVersion: env.FREEZE_VERSION,
      ghPath: readFileSync(ghPath, 'utf8'),
      calls: readFileSync(calls, 'utf8'),
      installedFreeze: existsSync(freezePath),
      // Existence is not usability: later steps execute mode bits, not files.
      installedFreezeExecutable:
        existsSync(freezePath) && (statSync(freezePath).mode & 0o111) !== 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('capture-tools install step (real bash, stubbed binaries)', () => {
  it('exits 0 on the worst runner — no passwordless sudo, broken apt, dead network', () => {
    const r = runCaptureToolsStep();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('freeze download failed');
    // Part of the never-stalls contract: a hung connection must abort at the
    // cap, not run out the job budget.
    expect(r.calls).toContain('--connect-timeout 10 --max-time 120');
    expect(r.installedFreeze).toBe(false);
  });

  it('exits 0 when the checksum rejects the download — and installs nothing', () => {
    // tar is stubbed to SUCCEED so the rejection is attributable to the
    // checksum alone: with tar unstubbed, deleting the sha256sum clause from
    // the workflow failed at tar instead and shipped green.
    const r = runCaptureToolsStep({
      stubs: { curl: okCurlStub, sha256sum: 'exit 1', tar: okTarStub },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('freeze checksum mismatch');
    expect(r.calls).toContain('sha256sum ');
    expect(r.calls).not.toContain('tar ');
    expect(r.installedFreeze).toBe(false);
  });

  it('happy path installs a USABLE pinned freeze into the step-owned dir', () => {
    const r = runCaptureToolsStep({
      stubs: { curl: okCurlStub, sha256sum: 'exit 0', tar: okTarStub },
    });
    expect(r.status).toBe(0);
    // The pairing later steps depend on: the binary AT the path GITHUB_PATH
    // names — one without the other and freeze is invisible or missing.
    expect(r.installedFreeze).toBe(true);
    expect(r.ghPath).toContain('.qwen-review-tools/bin');
    // ~/.local/bin is a persistent runner's general-purpose dumping ground:
    // promoting it would resolve arbitrary binaries ahead of the system
    // gh/git in the secret-bearing review step.
    expect(r.ghPath).not.toContain('.local/bin');
    // Existence is not usability: an install -m 0644 regression ships a file
    // that later steps cannot execute, silently degrading every capture.
    expect(r.installedFreezeExecutable).toBe(true);
    expect(r.stdout).toContain(r.freezeVersion);
  });

  it('re-downloads when the cached freeze is the WRONG version', () => {
    // A persistent runner keeps yesterday's freeze on PATH: a bare
    // `command -v` gate would make the FREEZE_VERSION bump a silent no-op.
    const r = runCaptureToolsStep({
      stubs: { freeze: 'echo "freeze version 0.0.1"' },
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('curl ');
  });

  it('re-downloads when the cached version merely CONTAINS the pin', () => {
    // A downgrade (0.2.20 -> 0.2.2) must re-download: the newer cached
    // version contains the older pin as a substring, so an unanchored grep
    // matched it and silently voided the pin.
    const r = runCaptureToolsStep({
      stubs: { freeze: 'echo "freeze version ${FREEZE_VERSION}0"' },
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('curl ');
  });

  it('skips the download when the cached freeze already matches the pin', () => {
    const r = runCaptureToolsStep({
      stubs: { freeze: 'echo "freeze version ${FREEZE_VERSION}"' },
    });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('curl ');
  });

  it('uses passwordless sudo for tmux only — freeze installs without sudo', () => {
    // The hosted-runner shape: sudo works. The default stubs pin sudo to
    // exit 1, so before this scenario no test ever executed the apt branch
    // and a regression breaking it shipped green while tmux stayed missing.
    const r = runCaptureToolsStep({
      stubs: {
        sudo: 'exit 0',
        curl: okCurlStub,
        sha256sum: 'exit 0',
        tar: okTarStub,
      },
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('sudo apt-get update -qq');
    expect(r.calls).toContain('sudo apt-get install -y -qq tmux');
    expect(r.calls).not.toContain('sudo install');
    expect(r.installedFreeze).toBe(true);
  });
});

describe('capture-tools step wiring', () => {
  it('installs before the review step its PATH promotion exists for', () => {
    // GITHUB_PATH entries and in-step PATH exports only reach LATER steps:
    // moved below 'Run review', the installed freeze is invisible to the
    // review while the install log still shows success.
    const install = workflow.indexOf(
      "- name: 'Install capture tools (tmux + freeze)'",
    );
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(workflow.indexOf("- name: 'Run review'"));
  });

  it('passes the assets-repo variable into the review step', () => {
    // The CLI reads QWEN_REVIEW_ASSETS_REPO from the environment; the run:
    // script never names it, so only this assertion sees a dropped or
    // misspelled wiring line.
    const doc = parse(workflow);
    expect(
      doc.jobs['review-pr'].steps.find((s) => s.name === 'Run review').env
        .QWEN_REVIEW_ASSETS_REPO,
    ).toBe('${{ vars.QWEN_REVIEW_ASSETS_REPO }}');
  });
});
