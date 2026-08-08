/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, describe, expect, it } from 'vitest';
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
import { basename, join, sep } from 'node:path';
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
function runScenario(scenario, { timeoutMinutes = 180, logPath } = {}) {
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
    // `timeout_kill` dies before the agent ever runs; `timeout_partial_line`
    // lets it stream first and only then reports 124, which is what a real
    // `--kill-after` SIGKILL looks like: output already on stdout, cut off
    // mid-line.
    write(
      'timeout',
      [
        '#!/bin/bash',
        'echo "$2" >> "$DUR"',
        'if [ "${SCENARIO:-}" = "timeout_kill" ]; then exit 124; fi',
        'shift',
        'shift',
        'if [ "${SCENARIO:-}" = "timeout_partial_line" ]; then "$@"; exit 124; fi',
        'exec "$@"',
      ].join('\n') + '\n',
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
        // A transcript that quotes a file containing a workflow command. The
        // real case: reviewing a PR that touches actions/setup-node, the agent
        // read that action's main.ts, which contains `##[add-matcher]...`.
        '  workflow_command) printf \'{"type":"assistant","content":"90-    const matchersPath = ...\\n91-    core.info(`##[add-matcher]${path.join(matchersPath, \\x27tsc.json\\x27)}`);"}\\n\'; r success false "Review complete: COMMENT posted (0 Critical)." ;;',
        // Killed mid-write: the last line reaches stdout WITHOUT its newline,
        // so whatever the step prints next lands on the same line.
        '  timeout_partial_line) printf \'{"type":"assistant","content":"90-    core.info(`##[add-matcher]x`);"}\\n{"type":"assistant","content":"91- trunc\' ;;',
        '  errresult) r error true "connection dropped mid-review" ;;',
        '  hardexit) exit 3 ;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    );
    const harness = [
      'set -euo pipefail',
      `QWEN_TIMEOUT=${timeoutMinutes}; MODEL_ARGS=(--model x); PROMPT="/review x"`,
      `LOG_PATH="${logPath ?? join(dir, 'log')}"`,
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
      // The whole transcript, so the stop-commands bracket around the agent
      // can be checked in the order the runner would see it.
      raw: stdout,
      attempts: Number(readFileSync(attemptFile, 'utf8').trim()),
      durations,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('qwen pr review workflow-command containment', () => {
  // The agent streams its whole transcript to stdout and the runner scans every
  // line for workflow commands, so a tool result that quotes a file containing
  // one gets EXECUTED. Observed on run 31167034020 (PR #8681): the agent read
  // actions/setup-node's main.ts, whose `core.info(\`##[add-matcher]...\`)`
  // made the runner take the rest of the JSON line as a matcher path — three
  // `Unable to process command` errors and 1h37m of review work discarded.
  // The runner matches `::cmd::` at the start of a line only, so both ends of
  // the bracket are located as WHOLE lines — a resume glued onto a partial
  // transcript line is inert text, and finding it by substring would report a
  // bracket the runner never closed.
  const bracketOf = (raw) => {
    const lines = raw.split('\n');
    const stopIdx = lines.findIndex((l) => l.startsWith('::stop-commands::'));
    const token =
      stopIdx === -1
        ? undefined
        : lines[stopIdx].slice('::stop-commands::'.length);
    return {
      token,
      lines,
      stopAt: stopIdx === -1 ? -1 : raw.indexOf(lines[stopIdx]),
      resumeAt: token ? raw.indexOf(`\n::${token}::\n`) : -1,
    };
  };

  it('brackets the agent transcript so a quoted command is inert', () => {
    const r = runScenario('workflow_command');
    // The review still succeeds — containment must not change the outcome.
    expect(r.line).toContain('OK outcome=success');

    const { token, stopAt, resumeAt } = bracketOf(r.raw);
    expect(token).toBeTruthy();
    // A fixed token could be re-enabled by anything the agent chose to print.
    expect(token).not.toBe('stop-commands');
    expect(token.length).toBeGreaterThan(16);

    // The dangerous line must land strictly INSIDE the bracket.
    const injected = r.raw.indexOf('##[add-matcher]');
    expect(injected).toBeGreaterThan(stopAt);
    expect(resumeAt).toBeGreaterThan(injected);
  });

  it('resumes command parsing on every agent outcome', () => {
    // Left off, the rest of the job goes silent: its own ::error:: and the
    // fallback comment's diagnostics would stop reaching the log — turning one
    // broken review into an unexplained one. The failure paths are the ones
    // that matter, since they are what still needs to report.
    for (const scenario of ['success', 'hardexit', 'timeout_kill']) {
      const { token, resumeAt } = bracketOf(runScenario(scenario).raw);
      expect(token, scenario).toBeTruthy();
      expect(resumeAt, scenario).toBeGreaterThan(-1);
    }
  });

  it('resumes on its own line when the agent is killed mid-write', () => {
    // `--kill-after` SIGKILLs the agent, so its last stream-json line can reach
    // stdout without a trailing newline. An `echo`d resume would be appended to
    // that fragment, where the runner never sees it at a line start: parsing
    // stays off for the remainder of the job — losing the retry `::warning::`
    // and every later diagnostic — on the exact path the guard exists for.
    const r = runScenario('timeout_partial_line');
    expect(r.line).toContain('FAIL kind=[timeout]');

    const { token, lines } = bracketOf(r.raw);
    expect(token).toBeTruthy();
    // The agent's truncated line really is truncated, or this proves nothing.
    expect(lines.some((l) => l.endsWith('"91- trunc'))).toBe(true);
    expect(lines).toContain(`::${token}::`);
  });

  it('resumes command parsing when the log write fails', () => {
    // The tee-failure branch returns before every other check, so a resume
    // relocated past it would leave parsing off exactly when the step still has
    // to report why it failed.
    const r = runScenario('success', {
      logPath: join(sep, 'nonexistent-qwen-review-dir', 'log'),
    });
    expect(r.line).toContain('Failed to write qwen review log');
    const { token, resumeAt } = bracketOf(r.raw);
    expect(token).toBeTruthy();
    expect(resumeAt).toBeGreaterThan(-1);
  });

  it('opens a fresh bracket for every attempt', () => {
    // Hoisting the stop echo and token out of `run_review_once` would still
    // pass every single-attempt test, but attempt 2 would then run unbracketed
    // under a token the runner has already consumed.
    const r = runScenario('transient_then_success');
    expect(r.attempts).toBe(2);
    const tokens = r.raw
      .split('\n')
      .filter((l) => l.startsWith('::stop-commands::'))
      .map((l) => l.slice('::stop-commands::'.length));
    expect(tokens).toHaveLength(2);
    // Per-attempt randomness: a reused token is one the transcript has already
    // had the chance to print.
    expect(new Set(tokens).size).toBe(2);
    for (const t of tokens) {
      expect(r.raw.split('\n')).toContain(`::${t}::`);
    }
  });

  it('reads the agent exit status before resuming', () => {
    // `echo` clobbers PIPESTATUS, so a resume placed before the capture would
    // read the echo's status instead of the agent's and report every timeout
    // or crash as a clean run. Pinned on the source because the symptom is a
    // silent misclassification, not a failure.
    const run = runReviewStep();
    const capture = run.indexOf('local ps=("${PIPESTATUS[@]}")');
    const resume = run.indexOf('printf \'\\n::%s::\\n\' "$stop_token"');
    const stop = run.indexOf('echo "::stop-commands::${stop_token}"');
    const agent = run.indexOf('--output-format stream-json');
    // Every anchor is asserted present: `indexOf` returns -1 when a line is
    // deleted or reworded, and -1 satisfies every ordering comparison below.
    expect(capture).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(capture);
    // And the stop must come before the agent it is meant to contain.
    expect(stop).toBeLessThan(agent);
  });
});

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
  // continue-on-error bounds failure, not duration: without a step-level
  // cap a stalled `sudo apt-get update` mirror eats the job's 300-minute
  // budget instead of degrading to ans-only.
  expect(step['timeout-minutes']).toBe(5);
  // The curl budget must fit that cap: if the worst-case retry budget
  // exceeds it, the cap fires mid-retry and the degradation branch and
  // scratch cleanup below the curl line are unreachable. The arithmetic
  // assumes the apt half above stays short — it shares the same cap, but
  // tmux is preinstalled on both runner classes, so it rarely runs at all.
  const retryFlag = /--retry (\d+)/.exec(step.run);
  const maxTimeFlag = /--max-time (\d+)/.exec(step.run);
  // Fail on the missing flag itself, not as a null dereference below.
  expect(retryFlag).not.toBeNull();
  expect(maxTimeFlag).not.toBeNull();
  const curlRetries = Number(retryFlag[1]);
  const curlMaxTime = Number(maxTimeFlag[1]);
  // + backoff: curl doubles its default 1s retry delay each retry, so
  // n retries add 2^n - 1s on top of the (retries + 1) transfer windows.
  expect(
    (curlRetries + 1) * curlMaxTime + (2 ** curlRetries - 1),
  ).toBeLessThanOrEqual(step['timeout-minutes'] * 60);
  // A freeze bump edits exactly these three adjacent lines. The harness
  // exports all of them into every stub, so a malformed or missing value can
  // never disagree with itself downstream — only this shape check sees it.
  expect(step.env.FREEZE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(step.env.FREEZE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  expect(step.env.FREEZE_BIN_SHA256).toMatch(/^[0-9a-f]{64}$/);
  return { run: step.run, env: step.env };
}

// The download half of the happy path: a curl that satisfies `-o <out>` but
// only for the exact pinned release URL, a sha256sum that only accepts a
// pinned checksum over a file curl actually wrote, and a tar that only
// "extracts" an existing file. Shared by the scenarios that vary only the
// verify/install half — each stub models its real contract's consumption
// side, so a wrong URL, hash variable, or severed file path fails the
// download exactly like production would.
const okCurlStub = [
  'url=""; out=""; prev=""',
  'for a in "$@"; do',
  '  [ "$prev" = "-o" ] && out="$a"',
  '  case "$a" in -*) ;; *) url="$a" ;; esac',
  '  prev="$a"',
  'done',
  'want="https://github.com/charmbracelet/freeze/releases/download/v${FREEZE_VERSION}/freeze_${FREEZE_VERSION}_Linux_x86_64.tar.gz"',
  '[ "$url" = "$want" ] && [ -n "$out" ] && : > "$out"',
].join('\n');
const okSha256Stub = [
  'read -r hash file',
  // Record the verified TARGET, not just the invocation: copy-then-verify is
  // void if the check reads anything other than the promoted per-run copy.
  'echo "sha256-target $file" >> "$CALLS"',
  '[ -f "$file" ] || exit 1',
  // The tarball check (FREEZE_SHA256) passes once curl wrote the file.
  'if [ "$hash" = "$FREEZE_SHA256" ]; then exit 0; fi',
  'if [ "$hash" = "$FREEZE_BIN_SHA256" ]; then',
  '  case "$file" in',
  // Target inside the download scratch = the just-extracted binary: the real
  // check passes iff FREEZE_SHA256 and FREEZE_BIN_SHA256 describe the same
  // release, which PINS_DISAGREE=1 negates (a transposed pair) — the one
  // invariant the stub world models but can never compute.
  '  *qwen-review-tools.dl.*) [ "${PINS_DISAGREE:-0}" = 1 ] || exit 0 ;;',
  // Any other target = the cached bytes copied into the per-run dir:
  // CACHE_HASH_OK=1 means they are the pinned binary's; anything else is a
  // planted or stale cache and must be rejected.
  '  *) [ "${CACHE_HASH_OK:-0}" = 1 ] && exit 0 ;;',
  '  esac',
  '  exit 1',
  'fi',
  'exit 1',
].join('\n');
const okTarStub = [
  'src=""; dest=""; prev=""',
  'for a in "$@"; do',
  '  [ "$prev" = "-xzf" ] && src="$a"',
  '  [ "$prev" = "-C" ] && dest="$a"',
  '  prev="$a"',
  'done',
  '[ -f "$src" ] || exit 1',
  'mkdir -p "$dest/freeze_x"',
  'printf \'#!/bin/bash\\necho "freeze ${FREEZE_VERSION}"\\n\' > "$dest/freeze_x/freeze"',
  'chmod +x "$dest/freeze_x/freeze"',
].join('\n');
// okTarStub's lying twin: the extracted binary REPORTS whatever version
// the scenario names. The report probes only the freeze this step installs,
// so the version-regex boundary coverage must ride in the promoted bytes.
function lyingVersionTarStub(reportedVersion) {
  return [
    'src=""; dest=""; prev=""',
    'for a in "$@"; do',
    '  [ "$prev" = "-xzf" ] && src="$a"',
    '  [ "$prev" = "-C" ] && dest="$a"',
    '  prev="$a"',
    'done',
    '[ -f "$src" ] || exit 1',
    'mkdir -p "$dest/freeze_x"',
    `printf '#!/bin/bash\\necho "freeze ${reportedVersion}"\\n' > "$dest/freeze_x/freeze"`,
    'chmod +x "$dest/freeze_x/freeze"',
  ].join('\n');
}

// Extracts "nothing": the tarball checksum passes but the archive holds no
// freeze binary.
const noBinTarStub = [
  'src=""; dest=""; prev=""',
  'for a in "$@"; do',
  '  [ "$prev" = "-xzf" ] && src="$a"',
  '  [ "$prev" = "-C" ] && dest="$a"',
  '  prev="$a"',
  'done',
  '[ -f "$src" ] || exit 1',
  'mkdir -p "$dest/freeze_x"',
].join('\n');

// The per-run tool dir's mktemp fails (RUNNER_TEMP unwritable), but the
// download-scratch mktemp still succeeds, honoring TMPDIR like the real one
// — so the scenario reaches the download-branch install with an empty
// `$tools_bin`.
const mktempNoToolsDirStub = [
  'for a in "$@"; do',
  '  case "$a" in',
  // The download-scratch template still succeeds: only the per-run tool
  // dir is unwritable in this scenario. The stub keeps the scratch dir's
  // name prefix — okSha256Stub keys on it to recognize the extracted
  // binary — while honoring TMPDIR like the real mktemp.
  '    *qwen-review-tools.dl.*) ;;',
  '    *qwen-review-tools*) exit 1 ;;',
  '  esac',
  'done',
  'd="${TMPDIR:-/tmp}/qwen-review-tools.dl.mkstub-$$"',
  'mkdir -p "$d" && echo "$d"',
].join('\n');

// Hide the host's tmux so whether the step's apt branch runs depends on the
// scenario, not on the machine hosting the suite. Blank ONLY the tmux entry,
// never its directory: on GitHub-hosted ubuntu runners tmux lives in /usr/bin,
// and dropping the whole directory takes bash, grep, and tar down with it —
// every test below then died on ENOENT in CI while passing on tmux-less dev
// machines. The farm depends only on process.env.PATH, so build it once
// instead of per scenario: re-reading and re-symlinking every host PATH dir
// (a full /usr/bin on CI) for every scenario was most of this file's runtime.
let cachedTmuxlessPath = null;
let cachedTmuxlessRoot = null;
function tmuxlessHostPath() {
  if (cachedTmuxlessPath !== null) return cachedTmuxlessPath;
  const root = mkdtempSync(join(tmpdir(), 'capture-tools-shadow-'));
  cachedTmuxlessRoot = root;
  let shadowSeq = 0;
  cachedTmuxlessPath = (process.env.PATH ?? '')
    .split(':')
    .map((d) => {
      if (!d || !existsSync(join(d, 'tmux'))) return d;
      const shadow = join(root, `shadow-${shadowSeq++}`);
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
  return cachedTmuxlessPath;
}
// The farm is cached across all scenarios, so no per-scenario finally owns
// it; the suite removes it once here.
afterAll(() => {
  if (cachedTmuxlessRoot !== null) {
    rmSync(cachedTmuxlessRoot, { recursive: true, force: true });
  }
});

function runCaptureToolsStep({
  stubs = {},
  cacheFreeze = null,
  cacheHashOk = false,
  pinsDisagree = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-tools-'));
  try {
    const bin = join(dir, 'bin');
    const homeDir = join(dir, 'home');
    const tmpRoot = join(dir, 'tmp');
    const runnerTemp = join(dir, 'runner-temp');
    const ghPath = join(dir, 'github_path');
    const calls = join(dir, 'calls');
    execFileSync('mkdir', ['-p', bin, homeDir, tmpRoot, runnerTemp]);
    // Seed a prior step's entry: on the hosted-runner path setup-node
    // appends the pinned node dir before this step runs, so a `>>` → `>`
    // regression clobbers it — invisible against an empty file.
    writeFileSync(ghPath, '/sentinel/setup-node/bin\n');
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
    const cacheDir = join(homeDir, '.qwen-review-tools/bin');
    if (cacheFreeze !== null) {
      execFileSync('mkdir', ['-p', cacheDir]);
      const p = join(cacheDir, 'freeze');
      writeFileSync(p, cacheFreeze);
      chmodSync(p, 0o755);
    }
    const { run, env } = captureToolsSource();
    const hostPath = tmuxlessHostPath();
    const harness = [
      `export HOME="${homeDir}"`,
      `export GITHUB_PATH="${ghPath}"`,
      `export CALLS="${calls}"`,
      // Pin TMPDIR: a regression to an untemplated `mktemp -d` puts the
      // download-scratch dir here, where leakedTmpEntries below sees it, and
      // the mktemp-failure stubs honor TMPDIR like the real mktemp.
      `export TMPDIR="${tmpRoot}"`,
      // The promoted per-run dir is created under RUNNER_TEMP, which survives
      // across jobs on the shared pool; 'Clean stale agent state' removes the
      // stale dirs before each run (pinned in the wiring block below).
      `export RUNNER_TEMP="${runnerTemp}"`,
      `export FREEZE_VERSION="${env.FREEZE_VERSION}"`,
      `export FREEZE_SHA256="${env.FREEZE_SHA256}"`,
      `export FREEZE_BIN_SHA256="${env.FREEZE_BIN_SHA256}"`,
      ...(cacheHashOk ? ['export CACHE_HASH_OK=1'] : []),
      ...(pinsDisagree ? ['export PINS_DISAGREE=1'] : []),
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
    // The dir GITHUB_PATH names is the ONLY PATH entry this step adds for the
    // job's later steps; its contents are exactly what those steps can
    // resolve ahead of the system gh/git.
    const ghPathContent = readFileSync(ghPath, 'utf8');
    const ghPathLines = ghPathContent.split('\n').filter((l) => l !== '');
    const promotedDir =
      ghPathLines.find((l) => l.includes('qwen-review-tools.')) ?? '';
    const promotedFreeze = promotedDir ? join(promotedDir, 'freeze') : '';
    const promotedFreezeExists =
      promotedDir !== '' && existsSync(promotedFreeze);
    return {
      status,
      stdout,
      freezeVersion: env.FREEZE_VERSION,
      ghPath: ghPathContent,
      // The seeded setup-node entry must survive the step's append.
      ghPathSentinelSurvived: ghPathLines.includes('/sentinel/setup-node/bin'),
      runnerTemp,
      calls: readFileSync(calls, 'utf8'),
      promotedDir: promotedDir || null,
      promotedEntries:
        promotedDir !== '' && existsSync(promotedDir)
          ? readdirSync(promotedDir)
          : [],
      promotedFreezeExists,
      // Existence is not usability: later steps execute mode bits, not files.
      promotedFreezeExecutable:
        promotedFreezeExists && (statSync(promotedFreeze).mode & 0o111) !== 0,
      // 0700 (mktemp's default) keeps any other job on the shared runner
      // out of the dir this step promotes onto PATH.
      promotedDirMode:
        promotedDir !== '' && existsSync(promotedDir)
          ? statSync(promotedDir).mode & 0o777
          : null,
      // The persistent cache dir is storage only — never promoted onto PATH.
      // The content snapshot outlives the scenario-dir cleanup for assertions.
      cacheFreezeExists: existsSync(join(cacheDir, 'freeze')),
      cacheFreezeContent: existsSync(join(cacheDir, 'freeze'))
        ? readFileSync(join(cacheDir, 'freeze'), 'utf8')
        : null,
      // Leak snapshots, taken before the scenario cleanup below: on the
      // persistent runner anything the step leaves behind accumulates
      // forever. TMPDIR catches a regression to an untemplated `mktemp -d`;
      // the templated scratch dir and the promoted tool dir land in the
      // separate RUNNER_TEMP tree, where only the promoted dir is exempt —
      // later steps of the same job still execute from it, and 'Clean stale
      // agent state' removes it before the next run.
      leakedTmpEntries: readdirSync(tmpRoot),
      leakedRunnerTempEntries: readdirSync(runnerTemp).filter(
        (e) => promotedDir === '' || e !== basename(promotedDir),
      ),
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
    // The other half of the every-degraded-path-says-why contract.
    expect(r.stdout).toContain('tmux unavailable');
    // Part of the never-stalls contract: a hung connection must abort at the
    // cap, not run out the job budget.
    expect(r.calls).toContain('--connect-timeout 10 --max-time 90');
    expect(r.promotedFreezeExists).toBe(false);
    expect(r.cacheFreezeExists).toBe(false);
    // Nothing verified installed, and the default stub world keeps a freeze
    // on PATH — the report names that risk without executing the plant.
    expect(r.stdout).toContain('no verified freeze installed');
    // A run that installs nothing must not prepend an empty dir to the
    // job's PATH.
    expect(r.ghPath).not.toContain('qwen-review-tools.');
    // A failed download still cleans its scratch dir: cleanup moved inside
    // the success branch leaks it on every dead-network run.
    expect(r.leakedTmpEntries).toStrictEqual([]);
    expect(r.leakedRunnerTempEntries).toStrictEqual([]);
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
    expect(r.promotedFreezeExists).toBe(false);
    expect(r.cacheFreezeExists).toBe(false);
    // The mktemp cleanup is load-bearing on the persistent runner:
    // RUNNER_TEMP survives across runs there, so a leaked scratch dir +
    // tarball accumulates forever.
    expect(r.leakedTmpEntries).toStrictEqual([]);
    expect(r.leakedRunnerTempEntries).toStrictEqual([]);
  });

  it('happy path promotes a FRESH per-run dir holding exactly the pinned freeze', () => {
    const r = runCaptureToolsStep({
      stubs: { curl: okCurlStub, sha256sum: okSha256Stub, tar: okTarStub },
    });
    expect(r.status).toBe(0);
    // The platform gate's exact invocation: `uname -m` alone returns x86_64,
    // which never equals 'Linux x86_64' — the download branch would silently
    // never run again.
    expect(r.calls).toContain('uname -sm');
    // The full flag set: dropping `-L` leaves curl writing 0 bytes of a 302
    // redirect, which the checksum stage then blames on the pin/SHA pair;
    // --retry-connrefused covers the refusals --retry alone ignores.
    expect(r.calls).toContain(
      'curl -fsSL --retry 2 --retry-connrefused --connect-timeout 10 --max-time 90 -o',
    );
    // The pairing later steps depend on: the executable binary IN the dir
    // GITHUB_PATH names, holding nothing else — one without the other and
    // freeze is invisible, missing, or shadowed by a planted neighbour.
    expect(r.promotedEntries).toStrictEqual(['freeze']);
    expect(r.promotedFreezeExecutable).toBe(true);
    expect(r.promotedDirMode).toBe(0o700);
    // The promoted dir is a fresh per-run dir, never the persistent cache:
    // $HOME survives across runs on the self-hosted runner and is writable
    // by any earlier job, so promoting it would resolve planted binaries
    // ahead of the system gh/git in the secret-bearing review step.
    expect(r.ghPath).toContain('qwen-review-tools.');
    expect(r.ghPath).not.toContain('.qwen-review-tools');
    // ~/.local/bin is a persistent runner's general-purpose dumping ground:
    // promoting it would resolve arbitrary binaries ahead of the system
    // gh/git in the secret-bearing review step.
    expect(r.ghPath).not.toContain('.local/bin');
    // The append must not clobber what an earlier step (setup-node) wrote.
    expect(r.ghPathSentinelSurvived).toBe(true);
    // The promoted dir must live inside the RUNNER_TEMP tree the stale-state
    // sweep owns — anywhere else leaks one dir + one binary per run.
    expect(r.promotedDir.startsWith(r.runnerTemp + sep)).toBe(true);
    // The verified download refreshes the cache for the next run.
    expect(r.cacheFreezeExists).toBe(true);
    expect(r.stdout).toContain(r.freezeVersion);
    // The pinned version resolved, so the stale-renderer warning stays silent.
    expect(r.stdout).not.toContain('not the pinned');
    expect(r.leakedTmpEntries).toStrictEqual([]);
    expect(r.leakedRunnerTempEntries).toStrictEqual([]);
  });

  it('accepts a cache whose bytes re-verify against the pinned hash — no download', () => {
    const r = runCaptureToolsStep({
      cacheFreeze: '#!/bin/bash\necho "freeze ${FREEZE_VERSION}"\n',
      cacheHashOk: true,
      stubs: { sha256sum: okSha256Stub },
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('sha256sum ');
    // Copy-then-verify: the verified bytes must be the promoted per-run
    // copy — verifying the cache source instead would re-open the swap the
    // ordering exists to close.
    expect(r.calls).toContain(`sha256-target ${join(r.promotedDir, 'freeze')}`);
    // The hash gate cleared, so the checksummed download stays skipped.
    expect(r.calls).not.toContain('curl ');
    expect(r.promotedEntries).toStrictEqual(['freeze']);
    expect(r.promotedFreezeExecutable).toBe(true);
    expect(r.cacheFreezeExists).toBe(true);
    expect(r.ghPathSentinelSurvived).toBe(true);
    expect(r.promotedDir.startsWith(r.runnerTemp + sep)).toBe(true);
    expect(r.stdout).toContain(r.freezeVersion);
    expect(r.stdout).not.toContain('not the pinned');
    // A hash-valid cache hit never enters the platform-degradation branch.
    expect(r.stdout).not.toContain('freeze unavailable');
  });

  it('hash-rejects a planted cache freeze that merely REPORTS the pinned version', () => {
    // The planted binary's --version lies about the pin — the old design
    // promoted the cache dir and trusted exactly this self-report. The marker
    // lives OUTSIDE the scenario dir (which the harness deletes) and proves
    // the plant never executes on the new path.
    const markerDir = mkdtempSync(join(tmpdir(), 'planted-marker-'));
    try {
      const planted = `#!/bin/bash
touch "${join(markerDir, 'pwned')}"
echo "freeze \${FREEZE_VERSION}"
`;
      const r = runCaptureToolsStep({
        cacheFreeze: planted,
        stubs: { curl: okCurlStub, sha256sum: okSha256Stub, tar: okTarStub },
      });
      expect(r.status).toBe(0);
      expect(r.calls).toContain('sha256sum ');
      // The rejection speaks: a silent rm here is exactly the degradation
      // the step's report exists to prevent.
      expect(r.stdout).toContain('cached freeze failed re-verification');
      expect(existsSync(join(markerDir, 'pwned'))).toBe(false);
      // The mismatch deletes the plant and forces the checksummed re-download.
      expect(r.calls).toContain('curl ');
      expect(r.promotedEntries).toStrictEqual(['freeze']);
      expect(r.promotedFreezeExists).toBe(true);
      // The cache now holds the verified download, not the plant.
      expect(r.cacheFreezeExists).toBe(true);
      expect(r.cacheFreezeContent).not.toBe(planted);
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it('deletes BOTH copies of a hash-rejected cache when the re-download cannot run', () => {
    // Dead-network twin of the scenario above: a successful re-download
    // overwrites both copies anyway, so only this variant catches a dropped
    // `rm -f` — with it gone the plant survives in the promoted per-run dir
    // and in the cache, and the step's own report probe executes it. The
    // default stubs model the dead network (curl exits 22); the marker
    // outside the scenario dir proves the plant never runs.
    const markerDir = mkdtempSync(join(tmpdir(), 'planted-deadnet-marker-'));
    try {
      const planted = `#!/bin/bash
touch "${join(markerDir, 'pwned')}"
echo "freeze \${FREEZE_VERSION}"
`;
      const r = runCaptureToolsStep({ cacheFreeze: planted });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('cached freeze failed re-verification');
      expect(r.stdout).toContain('freeze download failed');
      expect(existsSync(join(markerDir, 'pwned'))).toBe(false);
      expect(r.promotedFreezeExists).toBe(false);
      expect(r.cacheFreezeExists).toBe(false);
      // A failed re-download still cleans its scratch dir.
      expect(r.leakedTmpEntries).toStrictEqual([]);
      expect(r.leakedRunnerTempEntries).toStrictEqual([]);
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it('downloads even with a freeze already on PATH, and warns of it without executing it', () => {
    // PATH presence never satisfies the pin — the checksummed download runs
    // regardless (the removed trust branch accepted a self-reported
    // version). When the download fails, later steps still resolve the PATH
    // freeze; the report says so WITHOUT executing it — probing --version
    // is exactly the execution the trust model forbids.
    const r = runCaptureToolsStep({
      stubs: { freeze: 'echo "freeze version 0.0.1"' },
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('curl ');
    expect(r.stdout).toContain('no verified freeze installed');
    // The stub's version line reaches stdout only if the report executed
    // it — absence is the non-execution proof.
    expect(r.stdout).not.toContain('freeze version 0.0.1');
  });

  it('the report rejects an installed freeze whose version merely CONTAINS the pin', () => {
    // A downgrade (0.2.20 -> 0.2.2): the newer version contains the older
    // pin as a substring, so an unanchored grep matched it and silently
    // voided the pin. The digit-bounded regex guards the report's warning —
    // a substring match would silence the very degradation the report
    // exists to surface. The report probes only the installed freeze, so
    // the lying version ships in the extracted binary itself.
    const r = runCaptureToolsStep({
      stubs: {
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: lyingVersionTarStub('${FREEZE_VERSION}0'),
      },
    });
    expect(r.status).toBe(0);
    expect(r.promotedFreezeExists).toBe(true);
    expect(r.stdout).toContain('not the pinned');
  });

  it('the report rejects an installed freeze extending the pin with a leading digit', () => {
    // Mirror of the CONTAINS case (pin 0.2.2, resolved 10.2.2): without the
    // LEFT digit boundary the grep matches and the warning is silenced.
    const r = runCaptureToolsStep({
      stubs: {
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: lyingVersionTarStub('1${FREEZE_VERSION}'),
      },
    });
    expect(r.status).toBe(0);
    expect(r.promotedFreezeExists).toBe(true);
    expect(r.stdout).toContain('not the pinned');
  });

  it('the report names an installed freeze whose --version is silent', () => {
    // A pinned release whose --version emits nothing is broken, not stale —
    // the report says so instead of echoing a blank version line. The probe
    // targets the installed freeze, so the silent binary ships in the
    // promoted bytes.
    const silentTarStub = [
      'src=""; dest=""; prev=""',
      'for a in "$@"; do',
      '  [ "$prev" = "-xzf" ] && src="$a"',
      '  [ "$prev" = "-C" ] && dest="$a"',
      '  prev="$a"',
      'done',
      '[ -f "$src" ] || exit 1',
      'mkdir -p "$dest/freeze_x"',
      'printf \'#!/bin/bash\\nexit 0\\n\' > "$dest/freeze_x/freeze"',
      'chmod +x "$dest/freeze_x/freeze"',
    ].join('\n');
    const r = runCaptureToolsStep({
      stubs: {
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: silentTarStub,
      },
    });
    expect(r.status).toBe(0);
    expect(r.promotedFreezeExists).toBe(true);
    expect(r.stdout).toContain('produced no version output');
  });

  it('never executes a freeze already on PATH — even one REPORTING the pinned version', () => {
    // The removed trust branch accepted any PATH freeze whose own --version
    // matched the pin — a self-report the step's own FREEZE_BIN_SHA256
    // comment calls attacker-controllable, from dirs (~/.local/bin on the
    // hosted runner, any user-writable PATH dir on the persistent one) that
    // are writable between jobs. The marker lives OUTSIDE the scenario dir
    // and proves the plant never runs; the checksummed download replaces
    // it even when it lies well.
    const markerDir = mkdtempSync(join(tmpdir(), 'planted-path-marker-'));
    try {
      const planted = `#!/bin/bash
touch "${join(markerDir, 'pwned')}"
echo "freeze \${FREEZE_VERSION}"
`;
      const r = runCaptureToolsStep({
        stubs: {
          freeze: planted,
          curl: okCurlStub,
          sha256sum: okSha256Stub,
          tar: okTarStub,
        },
      });
      expect(r.status).toBe(0);
      expect(existsSync(join(markerDir, 'pwned'))).toBe(false);
      expect(r.calls).toContain('curl ');
      expect(r.promotedEntries).toStrictEqual(['freeze']);
      expect(r.promotedFreezeExists).toBe(true);
      // The verified download shadows the plant, so no degradation warning.
      expect(r.stdout).not.toContain('not the pinned');
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it('installs nothing when the per-run mktemp fails — never at an empty-prefix path', () => {
    // With `$tools_bin` empty the UNGUARDED download-branch install
    // resolved to `/freeze`: harmless for an unprivileged job, but a
    // root-in-container self-hosted runner writes it and reports success
    // with nothing on PATH. The install stub succeeds like root would, so
    // without the guard its recorded call at the empty-prefix target fails
    // this test.
    const r = runCaptureToolsStep({
      stubs: {
        mktemp: mktempNoToolsDirStub,
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: okTarStub,
        install: 'exit 0',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('freeze install failed');
    expect(r.calls).not.toMatch(/^install /m);
    expect(r.promotedDir).toBeNull();
    expect(r.cacheFreezeExists).toBe(false);
    expect(r.leakedTmpEntries).toStrictEqual([]);
  });

  it('ignores a hash-valid cache when the per-run mktemp fails — never installs at an empty-prefix path', () => {
    // Cache-path twin of the download-path guard: without the cache branch's
    // `[ -n "$tools_bin" ] &&`, the install target resolves to `/freeze` and
    // the recorded call fails this test. The valid cache must survive: it is
    // only ever deleted on a hash mismatch, not because the per-run dir is
    // absent.
    const r = runCaptureToolsStep({
      cacheFreeze: '#!/bin/bash\necho "freeze ${FREEZE_VERSION}"\n',
      cacheHashOk: true,
      stubs: {
        mktemp: mktempNoToolsDirStub,
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: okTarStub,
        install: 'exit 0',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('freeze install failed');
    expect(r.calls).not.toMatch(/^install /m);
    expect(r.promotedDir).toBeNull();
    expect(r.cacheFreezeExists).toBe(true);
    expect(r.leakedTmpEntries).toStrictEqual([]);
  });

  it('exits 0 when tar extraction fails — and installs nothing', () => {
    const r = runCaptureToolsStep({
      stubs: { curl: okCurlStub, sha256sum: okSha256Stub, tar: 'exit 1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('freeze tarball extraction failed');
    expect(r.calls).toContain('tar ');
    expect(r.promotedFreezeExists).toBe(false);
    expect(r.cacheFreezeExists).toBe(false);
    expect(r.leakedTmpEntries).toStrictEqual([]);
  });

  it('exits 0 when the verified tarball contains no freeze binary — and installs nothing', () => {
    const r = runCaptureToolsStep({
      stubs: { curl: okCurlStub, sha256sum: okSha256Stub, tar: noBinTarStub },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('verified tarball contains no freeze binary');
    expect(r.promotedFreezeExists).toBe(false);
    expect(r.cacheFreezeExists).toBe(false);
    expect(r.leakedTmpEntries).toStrictEqual([]);
  });

  it('refuses a verified tarball whose extracted binary misses FREEZE_BIN_SHA256', () => {
    // The two pins must describe the same release: the harness stubs key on
    // these same values, so a transposed pair passes every other scenario —
    // PINS_DISAGREE models the transposition, and the step must fail closed
    // at the self-check instead of promoting bytes the pin rejects.
    const r = runCaptureToolsStep({
      pinsDisagree: true,
      stubs: { curl: okCurlStub, sha256sum: okSha256Stub, tar: okTarStub },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'extracted freeze does not match FREEZE_BIN_SHA256',
    );
    expect(r.promotedFreezeExists).toBe(false);
    expect(r.cacheFreezeExists).toBe(false);
    expect(r.leakedTmpEntries).toStrictEqual([]);
    expect(r.leakedRunnerTempEntries).toStrictEqual([]);
  });

  it('exits 0 when the freeze install fails — and installs nothing', () => {
    const r = runCaptureToolsStep({
      stubs: {
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: okTarStub,
        install: 'exit 1',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('freeze install failed');
    expect(r.promotedFreezeExists).toBe(false);
    expect(r.cacheFreezeExists).toBe(false);
    expect(r.leakedTmpEntries).toStrictEqual([]);
  });

  it('keeps the promoted install when the cache update fails — and says so', () => {
    // The only scenario that fails the cache write while the per-run install
    // succeeds: the `|| echo` tolerance line is the degradation-reporting
    // contract here, and with it gone this branch shipped untested.
    const r = runCaptureToolsStep({
      stubs: {
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: okTarStub,
        // Fails only on the persistent-cache target; the per-run install
        // must succeed — and like the real install, a success copies the
        // bytes the promotedFreezeExists assertion below checks.
        install: [
          'for a in "$@"; do',
          '  case "$a" in */.qwen-review-tools/*) exit 1 ;; esac',
          'done',
          'cp "$3" "$4" || exit 1',
          'chmod 0755 "$4"',
        ].join('\n'),
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('freeze cache update failed');
    expect(r.promotedFreezeExists).toBe(true);
    expect(r.cacheFreezeExists).toBe(false);
    expect(r.leakedTmpEntries).toStrictEqual([]);
    expect(r.leakedRunnerTempEntries).toStrictEqual([]);
  });

  it('says why freeze is absent on a non-x86_64 runner', () => {
    // The platform guard used to skip the download silently: a pool
    // migrating to arm64 would degrade every capture with zero log lines,
    // contradicting the step's own never-degrade-silently contract.
    const r = runCaptureToolsStep({
      stubs: { uname: 'echo "Linux aarch64"', tmux: 'echo "tmux 3.4"' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'freeze unavailable on Linux aarch64; rendering captures will degrade to ans-only.',
    );
    expect(r.calls).not.toContain('curl ');
    expect(r.promotedFreezeExists).toBe(false);
  });

  it('skips apt entirely when tmux is already present', () => {
    // Both runner classes usually have tmux: without the guard every review
    // would re-run apt-get update+install.
    const r = runCaptureToolsStep({
      stubs: { tmux: 'echo "tmux 3.4"', sudo: 'exit 0' },
    });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('apt-get');
    expect(r.stdout).toContain('tmux 3.4');
  });

  it('uses passwordless sudo for tmux only — freeze installs without sudo', () => {
    // The hosted-runner shape: sudo works. The default stubs pin sudo to
    // exit 1, so before this scenario no test ever executed the apt branch
    // and a regression breaking it shipped green while tmux stayed missing.
    // The sudo stub EXECs what it is given, so apt-get really runs: a sudo
    // that swallowed its arguments would log success while tmux stayed out.
    const r = runCaptureToolsStep({
      stubs: {
        sudo: ['if [ "${1:-}" = "-n" ]; then shift; fi', 'exec "$@"'].join(
          '\n',
        ),
        'apt-get': 'exit 0',
        curl: okCurlStub,
        sha256sum: okSha256Stub,
        tar: okTarStub,
      },
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('sudo apt-get update -qq');
    expect(r.calls).toContain('sudo -n true');
    expect(r.calls).toContain('sudo apt-get install -y -qq tmux');
    // Anchored without sudo's prefix: proof of the exec passthrough.
    expect(r.calls).toMatch(/^apt-get update -qq$/m);
    expect(r.calls).toMatch(/^apt-get install -y -qq tmux$/m);
    expect(r.calls).not.toContain('sudo install');
    expect(r.promotedFreezeExists).toBe(true);
  });
});

describe('capture-tools step wiring', () => {
  it('installs before the review step its PATH promotion exists for', () => {
    // GITHUB_PATH entries only reach LATER steps: moved below 'Run review',
    // the installed freeze is invisible to the review while the install log
    // still shows success. Above 'Resolve PR
    // context', the step's if: reads an output that does not exist yet,
    // evaluates false, and the step is silently skipped on every run.
    const install = workflow.indexOf(
      "- name: 'Install capture tools (tmux + freeze)'",
    );
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(workflow.indexOf("- name: 'Run review'"));
    expect(install).toBeGreaterThan(
      workflow.indexOf("- name: 'Resolve PR context'"),
    );
    // And after the stale-state sweep: moved below the install step, the
    // sweep would rm -rf THIS run's freshly promoted tool dir before
    // 'Run review' resolves freeze.
    expect(install).toBeGreaterThan(
      workflow.indexOf("- name: 'Clean stale agent state'"),
    );
  });

  it('only runs when the review runs', () => {
    // Sibling-consistent guard: without it (or a misspelling of it) the
    // install step runs on every non-review firing of this workflow —
    // apt-get, a network download, and persistent cache + GITHUB_PATH writes
    // for a review that never happens. The job-level gate subsumes it today;
    // this pin catches a future loosening.
    const doc = parse(workflow);
    const step = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Install capture tools (tmux + freeze)',
    );
    expect(step.if).toBe("steps.context.outputs.should_run == 'true'");
  });

  it('cleans stale per-run tool dirs before the next run creates one', () => {
    // The install step creates one qwen-review-tools.* dir per run under
    // RUNNER_TEMP and nothing else removes it; RUNNER_TEMP survives across
    // jobs on the shared pool, so without this sweep every runner
    // accumulates one dir + one Go binary per review run. The 240-minute
    // age-gate spares live dirs if a RUNNER_TEMP is ever shared across
    // concurrent jobs or runners — a sibling sweep deleting this run's
    // promoted dir would silently degrade its captures.
    const doc = parse(workflow);
    const clean = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Clean stale agent state',
    ).run;
    expect(clean).toContain(
      'find "$RUNNER_TEMP" -maxdepth 1 -name \'qwen-review-tools.*\' -mmin +240 -exec rm -rf {} +',
    );
  });

  it('names the download scratch dir for the stale-dir sweep', () => {
    // A step killed mid-download never runs the scratch dir's own cleanup;
    // the age-gated sweep is its only removal, so the mktemp template must
    // match the sweep's -name pattern in both the parent dir and the prefix.
    const doc = parse(workflow);
    const install = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Install capture tools (tmux + freeze)',
    ).run;
    expect(install).toContain(
      'tmp=$(mktemp -d "${RUNNER_TEMP:-/tmp}/qwen-review-tools.dl.',
    );
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

describe('docs-only medium gate', () => {
  // The downgrade logic is inline bash in two steps; these tests extract and
  // EXECUTE the load-bearing fragments (prompt branch, timeout floor, the
  // completion-line allowlist) rather than asserting on their text, because
  // the surviving mutations are behavioral: swapping the if/elif order makes
  // parse-args force high effort back on AND post inline comments while the
  // relay still claims medium posted nothing; flipping the floor comparison
  // caps every size-tiered docs run at 90 minutes.
  const run = (() => {
    const doc = parse(workflow);
    return doc.jobs['review-pr'].steps.find((s) => s.name === 'Run review').run;
  })();

  function promptBranchSource() {
    const start = run.indexOf('PROMPT="/review ${REVIEW_URL}"');
    expect(start).toBeGreaterThan(-1);
    const end = run.indexOf('\nfi', start) + '\nfi'.length;
    return run.slice(start, end);
  }

  function buildPrompt({ docsOnlyMedium, reviewMode }) {
    const script = [
      'set -euo pipefail',
      'REVIEW_URL="https://x/pull/1"',
      `DOCS_ONLY_MEDIUM=${docsOnlyMedium}`,
      `REVIEW_MODE=${reviewMode}`,
      promptBranchSource(),
      'printf "%s" "$PROMPT"',
    ].join('\n');
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  }

  it('emits --effort medium INSTEAD OF --comment on the docs-only path', () => {
    const prompt = buildPrompt({
      docsOnlyMedium: 'true',
      reviewMode: 'comment',
    });
    expect(prompt).toContain('--effort medium');
    expect(prompt).not.toContain('--comment');
  });

  it('keeps --comment on the non-docs comment path', () => {
    const prompt = buildPrompt({
      docsOnlyMedium: 'false',
      reviewMode: 'comment',
    });
    expect(prompt).toContain('--comment');
    expect(prompt).not.toContain('--effort');
  });

  function floorSource() {
    const anchor = run.indexOf('# Medium measures at one-third to one-half');
    expect(anchor).toBeGreaterThan(-1);
    const start = run.indexOf('EFFECTIVE_TIMEOUT_MINUTES=$((', anchor);
    // The YAML parser strips the block scalar's base indentation, so the
    // floor's closing `fi` sits at four spaces in the parsed text.
    const end = run.indexOf('\n    fi', start) + '\n    fi'.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return run.slice(start, end);
  }

  it.each([
    [360, 180],
    [180, 90],
    [100, 90],
  ])(
    'halves the size-aware budget with a 90-minute floor (%i → %i)',
    (input, want) => {
      const script = [
        'set -euo pipefail',
        `EFFECTIVE_TIMEOUT_MINUTES=${input}`,
        floorSource(),
        'printf "%s" "$EFFECTIVE_TIMEOUT_MINUTES"',
      ].join('\n');
      expect(execFileSync('bash', ['-c', script], { encoding: 'utf8' })).toBe(
        String(want),
      );
    },
  );

  function completionBlockSource() {
    const anchor = run.indexOf('machine-readable completion contract');
    expect(anchor).toBeGreaterThan(-1);
    const start = run.lastIndexOf(
      'if [ "$DOCS_ONLY_MEDIUM" = "true" ]; then',
      anchor,
    );
    // Base indentation is stripped by the YAML parser: the block's outer `fi`
    // sits at column 0, its inner allowlist `fi` at two spaces — so `\nfi`
    // uniquely anchors the outer close.
    const end = run.indexOf('\nfi', anchor) + '\nfi'.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return run.slice(start, end);
  }

  function relayLine(resultText) {
    const dir = mkdtempSync(join(tmpdir(), 'review-completion-'));
    try {
      const gho = join(dir, 'gho');
      writeFileSync(gho, '');
      const script = [
        'set -euo pipefail',
        'DOCS_ONLY_MEDIUM=true',
        'PR_NUMBER=123',
        `GITHUB_OUTPUT="${gho}"`,
        `RESULT_TEXT=$(cat "${join(dir, 'result')}")`,
        completionBlockSource(),
      ].join('\n');
      writeFileSync(join(dir, 'result'), resultText);
      execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      return readFileSync(gho, 'utf8').trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('relays only the not-posted disposition shape', () => {
    expect(
      relayLine(
        'prose...\nReview complete: pr-123 — Comment, not posted (0 Critical, 2 Suggestion)',
      ),
    ).toBe(
      'completion_line=Review complete: pr-123 — Comment, not posted (0 Critical, 2 Suggestion)',
    );
  });

  it.each([
    // The measured phantom: a posted-form disposition on a path that never posts.
    'Review complete: pr-123 — APPROVE posted',
    'Review complete: pr-123 — COMMENT posted (0 Critical, 1 Suggestion inline)',
    // Reworded/missing completion lines.
    'The review finished fine, trust me.',
    '',
  ])('falls back to the neutral non-scrapable form for %j', (text) => {
    const line = relayLine(text);
    expect(line.startsWith('completion_line=(no relayable')).toBe(true);
    // The fallback must never mint the reserved machine prefix.
    expect(line).not.toContain('completion_line=Review complete:');
  });

  it('accepts the Request-changes disposition a Critical-finding medium run emits', () => {
    // compose-review caps only Approve at medium: a verified Critical still
    // yields Request changes, and that is exactly the outcome the relay must
    // not swallow into the neutral fallback.
    const line =
      'Review complete: pr-123 — Request changes, not posted (1 Critical, 0 Suggestion)';
    expect(relayLine(`prose...\n${line}`)).toBe(`completion_line=${line}`);
  });

  it('relays the LAST completion line, not a stale or injected earlier one', () => {
    const stale =
      'Review complete: pr-123 — Comment, not posted (9 Critical, 9 Suggestion)';
    const valid =
      'Review complete: pr-123 — Comment, not posted (0 Critical, 2 Suggestion)';
    expect(relayLine(`${stale}\nmore prose\n${valid}`)).toBe(
      `completion_line=${valid}`,
    );
  });

  it('rejects the Approve verdict medium can never produce', () => {
    // Widening the alternation to include Approve must turn this red: an
    // injection-steered approval must not be republished under the bot's name.
    const line = relayLine(
      'Review complete: pr-123 — Approve, not posted (0 Critical, 0 Suggestion)',
    );
    expect(line.startsWith('completion_line=(no relayable')).toBe(true);
  });

  it("rejects another PR's completion line (target binding)", () => {
    const line = relayLine(
      'Review complete: pr-999 — Comment, not posted (0 Critical, 2 Suggestion)',
    );
    expect(line.startsWith('completion_line=(no relayable')).toBe(true);
  });

  it('classifies review_requested as an explicit ask, never automatic', () => {
    const doc = parse(workflow);
    const context = doc.jobs['review-pr'].steps.find((s) => s.id === 'context');
    // One assignment site, guarded on both the event and the action.
    expect(context.run.match(/AUTO_REVIEW=true/g)).toHaveLength(1);
    // The false DEFAULT is load-bearing too: without it, dispatch,
    // issue-comment and review-comment triggers inherit whatever the
    // environment carries and can enter the automatic downgrade path.
    expect(context.run.match(/AUTO_REVIEW=false/g)).toHaveLength(1);
    expect(context.run.indexOf('AUTO_REVIEW=false')).toBeLessThan(
      context.run.indexOf('AUTO_REVIEW=true'),
    );
    // Both halves of the guard: the event must be pull_request_target AND the
    // action must not be review_requested. Pinning only the action half let a
    // deleted event condition survive — the branch is shared with
    // pull_request_review(_comment), whose actions are never review_requested,
    // so a review-body `@qwen-code /review` would have downgraded silently.
    expect(context.run).toMatch(
      /= "pull_request_target" \] &&\s*\n\s*\[ "\$\{\{ github\.event\.action \}\}" != "review_requested" \]; then\s*\n\s*AUTO_REVIEW=true/,
    );
  });

  it('pins the relay marker producer↔filter contract, author-scoped', () => {
    // Producer side: the marker literal as the relay step actually posts it.
    const doc = parse(workflow);
    const relay = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Report docs-only medium outcome',
    );
    const m = relay.run.match(/<!-- qwen-review docs-only-medium -->/);
    expect(m).not.toBeNull();
    // Filter side: every autofix exclusion of that marker must carry the
    // author scope ($rb) — a human quoting the marker stays actionable —
    // and all six inline copies in qwen-autofix.yml must be present.
    const autofix = readFileSync('.github/workflows/qwen-autofix.yml', 'utf8');
    const scoped =
      autofix.match(
        /\(\.user\.login \/\/ ""\) == \$rb\)\) and \(\(\.body \/\/ ""\) \| test\("<!-- qwen-review docs-only-medium "\)\)\) \| not\)/g,
      ) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(6);
    // No body-only exclusion of the marker may survive anywhere: every
    // marker test must carry the author scope, and a filter missing
    // `| not` inverts to keep ONLY the badge — it then drops out of the
    // scoped count above, so either mutant fails this pin.
    const markerTests =
      autofix.match(/test\("<!-- qwen-review docs-only-medium "\)/g) ?? [];
    expect(markerTests.length).toBe(scoped.length);
  });

  it('routes classification through the shared classify-pr-profile wrapper', () => {
    // Both this gate and ci.yml must consume the classifier via the shared
    // script so its input contract lives in one place.
    expect(run).toContain('.github/scripts/ci/classify-pr-profile.sh');
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('.github/scripts/ci/classify-pr-profile.sh');
    expect(ci).not.toContain(
      "--jq '.[] | {filename, status, previous_filename}'",
    );
  });
});

describe('docs-only gate and relay, executed', () => {
  // R2-4 / R3-4: the classification gate and the relay step are the feature's
  // two integration boundaries; both are executed here with stubbed
  // executables rather than asserted as text, because the probed mutants
  // (flipped PATCH/POST branch, swapped exit-code handling, inverted
  // docs_only comparison) all stayed green under text-only assertions.
  const doc = parse(workflow);
  const runStep = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Run review',
  ).run;
  const relayRun = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Report docs-only medium outcome',
  ).run;

  function gateSource() {
    const start = runStep.indexOf('DOCS_ONLY_MEDIUM=""');
    const endAnchor =
      'echo "docs_only_medium=$DOCS_ONLY_MEDIUM" >> "$GITHUB_OUTPUT"';
    const end = runStep.indexOf(endAnchor) + endAnchor.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return runStep.slice(start, end);
  }

  function runGate({ autoReview, wrapper }) {
    const dir = mkdtempSync(join(tmpdir(), 'docs-gate-'));
    try {
      const stub = join(dir, '.github/scripts/ci');
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, 'classify-pr-profile.sh'), wrapper);
      chmodSync(join(stub, 'classify-pr-profile.sh'), 0o755);
      const gho = join(dir, 'gho');
      writeFileSync(gho, '');
      const script = [
        'set -euo pipefail',
        `AUTO_REVIEW=${autoReview}`,
        'REPO=o/r',
        'PR_NUMBER=42',
        'EFFECTIVE_TIMEOUT_MINUTES=360',
        `GITHUB_OUTPUT="${gho}"`,
        gateSource(),
        'printf "timeout=%s" "$EFFECTIVE_TIMEOUT_MINUTES"',
      ].join('\n');
      const stdout = execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        cwd: dir,
      });
      return { stdout, output: readFileSync(gho, 'utf8').trim() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('downgrades and halves the budget when the classifier says docs_only', () => {
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho docs_only\n',
    });
    expect(r.output).toBe('docs_only_medium=true');
    expect(r.stdout).toContain('timeout=180');
  });

  it('keeps the full review for a full classification', () => {
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho full\n',
    });
    expect(r.output).toBe('docs_only_medium=false');
    expect(r.stdout).toContain('timeout=360');
  });

  it('falls back to the full review when the wrapper fails', () => {
    const r = runGate({ autoReview: 'true', wrapper: '#!/bin/bash\nexit 2\n' });
    // Empty, not 'false': a failed classification is 'never determined', and
    // the supersede step must not read it as a positive determination.
    expect(r.output).toBe('docs_only_medium=');
    expect(r.stdout).toContain('could not classify');
    expect(r.stdout).toContain('timeout=360');
  });

  it('keeps the full review for github_ci_only (CI helpers are executable)', () => {
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho github_ci_only\n',
    });
    expect(r.output).toBe('docs_only_medium=false');
    expect(r.stdout).toContain('timeout=360');
  });

  it('never classifies on an explicit (non-automatic) run', () => {
    const r = runGate({
      autoReview: 'false',
      wrapper: '#!/bin/bash\necho docs_only\n',
    });
    expect(r.output).toBe('docs_only_medium=');
    expect(r.stdout).toContain('timeout=360');
  });

  function runRelay({ scenario }) {
    const dir = mkdtempSync(join(tmpdir(), 'docs-relay-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const calls = join(dir, 'calls');
      writeFileSync(calls, '');
      const write = (name, body) => {
        writeFileSync(join(bin, name), body);
        chmodSync(join(bin, name), 0o755);
      };
      write('sleep', '#!/bin/bash\nexit 0\n');
      write(
        'gh',
        [
          '#!/bin/bash',
          'echo "$*" >> "$CALLS"',
          // The head-binding guard runs BEFORE the upsert attempts: pr view
          // succeeds even in all-fail so that scenario still exercises the
          // retry loop, while moved-head/closed-pr exercise the guard.
          'case "$*" in',
          '  "pr view"*)',
          '    if [ "$SCENARIO" = "moved-head" ]; then printf "OPEN\\tdeadbeef\\n";',
          '    elif [ "$SCENARIO" = "closed-pr" ]; then printf "MERGED\\tabc123\\n";',
          '    else printf "OPEN\\tabc123\\n"; fi',
          '    exit 0 ;;',
          'esac',
          'if [ "$SCENARIO" = "all-fail" ]; then exit 1; fi',
          'case "$*" in',
          '  "api user"*) echo \'{"login":"relay-bot"}\' | jq -r .login; exit 0 ;;',
          '  *"--method GET"*)',
          '    if [ "$SCENARIO" = "existing" ]; then',
          '      echo \'[{"id":777,"user":{"login":"relay-bot"},"body":"<!-- qwen-review docs-only-medium --> old"}]\'',
          '    else echo "[]"; fi ;;',
          '  *) : ;;',
          'esac',
          'exit 0',
        ].join('\n') + '\n',
      );
      const script = [
        'set -euo pipefail',
        'GITHUB_REPOSITORY=o/r',
        'PR_NUMBER=42',
        `RUNNER_TEMP="${dir}"`,
        'EXPECTED_HEAD_SHA=abc123',
        'COMPLETION_LINE="Review complete: pr-42 — Comment, not posted (0 Critical, 1 Suggestion)"',
        'RUN_URL=https://x',
        relayRun,
      ].join('\n');
      const stdout = execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SCENARIO: scenario,
          CALLS: calls,
        },
      });
      return { stdout, calls: readFileSync(calls, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('POSTs a fresh relay comment when none exists', () => {
    const r = runRelay({ scenario: 'fresh' });
    expect(r.stdout).toContain('relayed to PR #42');
    expect(r.calls).toContain('api repos/o/r/issues/42/comments -f');
    expect(r.calls).not.toContain('--method PATCH');
    // The POSTed body must carry the marker — it is the dedup key both the
    // upsert lookup and the supersede step match on; a body without it makes
    // every push stack a new badge and supersede match nothing.
    expect(r.calls).toContain('<!-- qwen-review docs-only-medium -->');
    // The badge is bound to the reviewed head: a later push must never be
    // described by an earlier revision's outcome.
    expect(r.calls).toContain('Reviewed head: `abc123`');
  });

  it('PATCHes the existing bot-authored relay comment', () => {
    const r = runRelay({ scenario: 'existing' });
    expect(r.stdout).toContain('relayed to PR #42');
    expect(r.calls).toContain(
      'api --method PATCH repos/o/r/issues/comments/777',
    );
  });

  it('warns and exits 0 when every attempt fails', () => {
    const r = runRelay({ scenario: 'all-fail' });
    expect(r.stdout).toContain('::warning::');
    expect(r.stdout).toContain('the review itself succeeded');
  });

  it('skips the relay when the head moved before the write', () => {
    const r = runRelay({ scenario: 'moved-head' });
    expect(r.stdout).toContain('moved from abc123 to deadbeef');
    expect(r.calls).not.toContain('api repos/o/r/issues/42/comments');
  });

  it('skips the relay when the PR closed before the write', () => {
    const r = runRelay({ scenario: 'closed-pr' });
    expect(r.stdout).toContain('is MERGED');
    expect(r.calls).not.toContain('api repos/o/r/issues/42/comments');
  });

  function normalizedIf(step) {
    return step.if.replace(/\s+/g, ' ').trim();
  }

  it('pins the relay if: as the exact reviewed conjunction', () => {
    // Full-string pin, not substrings: deleting or weakening any conjunct —
    // or re-grouping them — edits this string, so every truth-table mutant
    // reduces to a red test here without an Actions-expression evaluator.
    const doc2 = parse(workflow);
    const relay = doc2.jobs['review-pr'].steps.find(
      (s) => s.name === 'Report docs-only medium outcome',
    );
    expect(normalizedIf(relay)).toBe(
      "steps.context.outputs.should_run == 'true' && " +
        "steps.review.outcome == 'success' && " +
        "steps.review.outputs.review_completed == 'true' && " +
        "steps.review.outputs.docs_only_medium == 'true' && " +
        "steps.context.outputs.pr_number != ''",
    );
  });

  it('pins the supersede if: including the OR grouping of its three paths', () => {
    const doc2 = parse(workflow);
    const supersede = doc2.jobs['review-pr'].steps.find(
      (s) => s.name === 'Supersede stale docs-only badge',
    );
    expect(normalizedIf(supersede)).toBe(
      '!cancelled() && ' +
        "steps.context.outputs.should_run == 'true' && " +
        "steps.context.outputs.pr_number != '' && " +
        "( steps.review.outputs.docs_only_medium == 'false' || " +
        "( steps.context.outputs.auto_review == 'false' && " +
        "steps.context.outputs.review_mode == 'comment' && " +
        "steps.review.outputs.review_completed == 'true' ) || " +
        "( failure() && steps.review.outputs.docs_only_medium == 'true' ) )",
    );
  });

  it('pins the review_completed wiring end to end', () => {
    // The state/head guards exit 0 without running the review; the relay
    // must require the dedicated output, and the run step must emit it
    // AFTER those guards — a hoisted emit would open the relay gate for a
    // closed/stale PR whose review never ran (position pinned below). The
    // supersede step deliberately does NOT require it: a failed full review
    // still owes the badge correction, gated on docs_only_medium == 'false'
    // (empty on runs that failed before classifying).
    const emitAt = runStep.indexOf('echo "review_completed=true"');
    expect(emitAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(
      runStep.indexOf('if [ "$PR_STATE" != "OPEN" ]'),
    );
    expect(emitAt).toBeGreaterThan(
      runStep.indexOf('Skipping stale review run'),
    );
    const doc2 = parse(workflow);
    const relay = doc2.jobs['review-pr'].steps.find(
      (s) => s.name === 'Report docs-only medium outcome',
    );
    expect(relay.if).toContain(
      "steps.review.outputs.review_completed == 'true'",
    );
    const supersede = doc2.jobs['review-pr'].steps.find(
      (s) => s.name === 'Supersede stale docs-only badge',
    );
    // Path (1): a POSITIVE not-docs-only determination (three-valued output;
    // empty = never determined) — deliberately without review success.
    expect(supersede.if).toContain(
      "steps.review.outputs.docs_only_medium == 'false'",
    );
    // Path (2): an explicit comment-mode review that completed (the badge's
    // CTA); a dispatch dry-run retires nothing.
    expect(supersede.if).toContain(
      "steps.context.outputs.auto_review == 'false'",
    );
    expect(supersede.if).toContain(
      "steps.context.outputs.review_mode == 'comment'",
    );
    expect(supersede.if).toContain(
      "steps.review.outputs.review_completed == 'true'",
    );
    expect(supersede.if).toContain('!cancelled()');
  });

  it('pins the supersede invocation shape (update-only, shared marker)', () => {
    const doc2 = parse(workflow);
    for (const name of [
      'Report docs-only medium outcome',
      'Supersede stale docs-only badge',
    ]) {
      const step = doc2.jobs['review-pr'].steps.find((s) => s.name === name);
      // One marker definition serving both the body and the lookup argument.
      expect(step.run).toContain(
        "MARKER='<!-- qwen-review docs-only-medium -->'",
      );
      expect(step.run).toContain('"$MARKER"');
    }
    const supersede = doc2.jobs['review-pr'].steps.find(
      (s) => s.name === 'Supersede stale docs-only badge',
    );
    expect(supersede.run).toContain('--update-only');
  });

  it('pins the auto_review output→env wiring at both links', () => {
    const doc2 = parse(workflow);
    const context = doc2.jobs['review-pr'].steps.find(
      (s) => s.id === 'context',
    );
    expect(context.run).toContain('echo "auto_review=$AUTO_REVIEW"');
    const review = doc2.jobs['review-pr'].steps.find(
      (s) => s.name === 'Run review',
    );
    expect(review.env.AUTO_REVIEW).toBe(
      '${{ steps.context.outputs.auto_review }}',
    );
  });
});

describe('supersede step and ci.yml rc-handling, executed', () => {
  const doc = parse(workflow);
  const supersedeRun = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Supersede stale docs-only badge',
  ).run;

  function runSupersede({
    scenario,
    docsOnlyMedium = 'false',
    reviewCompleted = 'true',
    expectedHeadSha = 'abc123',
  }) {
    const dir = mkdtempSync(join(tmpdir(), 'docs-supersede-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const calls = join(dir, 'calls');
      writeFileSync(calls, '');
      const write = (name, body) => {
        writeFileSync(join(bin, name), body);
        chmodSync(join(bin, name), 0o755);
      };
      write('sleep', '#!/bin/bash\nexit 0\n');
      write(
        'gh',
        [
          '#!/bin/bash',
          'echo "$*" >> "$CALLS"',
          // The head-binding guard runs BEFORE the upsert attempts: pr view
          // succeeds even in all-fail so that scenario still exercises the
          // retry loop.
          'case "$*" in',
          '  "pr view"*)',
          '    if [ "$SCENARIO" = "moved-head" ]; then printf "OPEN\\tdeadbeef\\n";',
          '    elif [ "$SCENARIO" = "closed-pr" ]; then printf "MERGED\\tabc123\\n";',
          '    else printf "OPEN\\tabc123\\n"; fi',
          '    exit 0 ;;',
          'esac',
          'if [ "$SCENARIO" = "all-fail" ]; then exit 1; fi',
          'case "$*" in',
          '  "api user"*) echo bot ;;',
          '  *"--method GET"*)',
          '    echo \'[{"id":31,"user":{"login":"bot"},"body":"<!-- qwen-review docs-only-medium --> badge"}]\' ;;',
          '  *) : ;;',
          'esac',
          'exit 0',
        ].join('\n') + '\n',
      );
      const script = [
        'set -euo pipefail',
        'GITHUB_REPOSITORY=o/r',
        'PR_NUMBER=42',
        `RUNNER_TEMP="${dir}"`,
        `EXPECTED_HEAD_SHA=${expectedHeadSha}`,
        `DOCS_ONLY_MEDIUM=${docsOnlyMedium}`,
        `REVIEW_COMPLETED=${reviewCompleted}`,
        'RUN_URL=https://x',
        supersedeRun,
        'echo "STEP_EXIT_OK"',
      ].join('\n');
      const stdout = execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SCENARIO: scenario,
          CALLS: calls,
        },
      });
      return { stdout, calls: readFileSync(calls, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('supersedes an existing bot-authored badge (PATCH, update-only)', () => {
    const r = runSupersede({ scenario: 'existing' });
    expect(r.calls).toContain(
      'api --method PATCH repos/o/r/issues/comments/31',
    );
    expect(r.stdout).toContain('STEP_EXIT_OK');
    // Cause-neutral retired wording: it must hold even when an explicit full
    // review completes on the SAME head the badge describes, so it may not
    // claim the badge described an earlier revision.
    expect(r.calls).toContain('(superseded)');
    expect(r.calls).toContain(
      'no longer reflects the current review state of this PR',
    );
    expect(r.calls).not.toContain('earlier docs-only revision');
  });

  it('updates the badge to a failure notice when a docs-only review failed', () => {
    // The relay only runs on success; without this path the badge would keep
    // quoting the previous revision's outcome for a head whose own run died.
    const r = runSupersede({
      scenario: 'existing',
      docsOnlyMedium: 'true',
      reviewCompleted: '',
    });
    expect(r.calls).toContain(
      'api --method PATCH repos/o/r/issues/comments/31',
    );
    expect(r.calls).toContain('did not complete');
    expect(r.calls).toContain('abc123');
    expect(r.stdout).toContain('STEP_EXIT_OK');
  });

  it('skips the badge update when the head moved before the write', () => {
    const r = runSupersede({ scenario: 'moved-head' });
    expect(r.stdout).toContain('moved from abc123 to deadbeef');
    expect(r.calls).not.toContain('--method PATCH');
  });

  it('skips the badge update when the PR closed before the write', () => {
    const r = runSupersede({ scenario: 'closed-pr' });
    expect(r.stdout).toContain('is MERGED');
    expect(r.calls).not.toContain('--method PATCH');
  });

  it('skips the badge update when the reviewed head SHA is unknown', () => {
    // A run that failed before "Run review" emitted the SHA has nothing to
    // bind to — a badge is never updated on ignorance.
    const r = runSupersede({ scenario: 'existing', expectedHeadSha: '' });
    expect(r.stdout).toContain('reviewed head SHA is unknown');
    expect(r.calls).not.toContain('--method PATCH');
  });

  it('warns and exits 0 when every supersede attempt fails', () => {
    // The never-fail guard is load-bearing: a failing step here would trip
    // the post-failure fallback into announcing a review failure that never
    // happened (the same phantom the relay guard prevents).
    const r = runSupersede({ scenario: 'all-fail' });
    expect(r.stdout).toContain('::warning::Could not supersede');
    expect(r.stdout).toContain('STEP_EXIT_OK');
  });

  function ciRcFragment() {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const ciDoc = parse(ci);
    let run;
    for (const job of Object.values(ciDoc.jobs)) {
      for (const step of job.steps ?? []) {
        if ((step.run ?? '').includes('classify-pr-profile.sh')) run = step.run;
      }
    }
    expect(run).toBeTruthy();
    const start = run.indexOf('set +e');
    expect(start).toBeGreaterThan(-1);
    const indent = run.slice(run.lastIndexOf('\n', start) + 1, start);
    const end = run.indexOf(`\n${indent}fi`, start) + `\n${indent}fi`.length;
    expect(end).toBeGreaterThan(start);
    return run.slice(start, end);
  }

  function runCiFragment(wrapper) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-rc-'));
    try {
      const stub = join(dir, '.github/scripts/ci');
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, 'classify-pr-profile.sh'), wrapper);
      chmodSync(join(stub, 'classify-pr-profile.sh'), 0o755);
      const script = [
        'set -euo pipefail',
        'profile=full',
        'GITHUB_REPOSITORY=o/r',
        'PR_NUMBER=42',
        ciRcFragment(),
        'printf "profile=%s" "$profile"',
      ].join('\n');
      return execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        cwd: dir,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('ci.yml consumes the wrapper result on success', () => {
    expect(runCiFragment('#!/bin/bash\necho docs_only\n')).toContain(
      'profile=docs_only',
    );
  });

  it.each([
    ['#!/bin/bash\nexit 2\n', 'Unable to list PR changed files'],
    ['#!/bin/bash\nexit 3\n', 'classifier exited non-zero'],
  ])('ci.yml falls back to full on wrapper failure (%#)', (wrapper, note) => {
    // The probed mutant (deleting the rc handling) leaves profile EMPTY on
    // failure — no downstream matrix bucket matches empty, and a broken PR
    // would pass CI with zero tests run.
    const out = runCiFragment(wrapper);
    expect(out).toContain(note);
    expect(out).toContain('profile=full');
  });
});

describe('upstream-timeout headroom (PR 8507 incident)', () => {
  // Three knobs, three failure modes: the SDK request timeout covers
  // connect+TTFB (three ~120s internal retries produced the 483s visible
  // abort on a small turn), the idle window covers a stalled generation
  // (the 17-agent fan-out on a ~1.27M-token context), and the lifetime cap
  // must exceed the idle window or a single legitimate gap trips the
  // drip-feed guard first. All three ride step env on 'Run review':
  // QWEN_CODE_API_TIMEOUT_MS outranks settings in model-config resolution
  // (so no settings.json write is needed) and step env outranks any stray
  // runner-level env of the same name.
  const doc = parse(workflow);
  const env = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Run review',
  ).env;

  it('raises the SDK request timeout via QWEN_CODE_API_TIMEOUT_MS', () => {
    expect(env.QWEN_CODE_API_TIMEOUT_MS).toBe('600000');
  });

  it('raises the stream guards with lifetime strictly above idle', () => {
    expect(env.QWEN_STREAM_IDLE_TIMEOUT_MS).toBe('600000');
    expect(env.QWEN_STREAM_MAX_LIFETIME_MS).toBe('1800000');
    expect(Number(env.QWEN_STREAM_MAX_LIFETIME_MS)).toBeGreaterThan(
      Number(env.QWEN_STREAM_IDLE_TIMEOUT_MS),
    );
  });
});

describe('workflow expression length', () => {
  // A `run:` body containing `${{ }}` is evaluated as ONE expression template,
  // and GitHub caps a single expression at 21000 characters. Blowing that cap
  // does not fail a job — it makes the whole workflow file *invalid*, so no
  // event triggers it at all and no run is even created for the ones that
  // matter. That is how every automatic review and every `@qwen-code /review`
  // in this repository silently stopped for ~12h on 2026-08-07: #8648 pushed
  // the "Run review" body from 17705 to 22282 characters, and from that merge
  // onward the only runs left were startup failures reading
  // `Invalid workflow file: … (Line: 751, Col: 14): Exceeded max expression
  // length 21000` (e.g. run 31239579253). CI stayed green the whole time — no
  // test covered this, which is why it is covered here.
  const LIMIT = 21000;
  const dir = '.github/workflows';
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it('keeps every templated run block under the limit', () => {
    expect(files.length).toBeGreaterThan(0);
    const over = [];
    for (const file of files) {
      const doc = parse(readFileSync(join(dir, file), 'utf8'));
      for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
          const body = step?.run;
          if (typeof body !== 'string' || !body.includes('${{')) continue;
          if (body.length > LIMIT) {
            over.push(
              `${file} › ${jobId} › ${step.name}: ${body.length} chars`,
            );
          }
        }
      }
    }
    expect(over).toEqual([]);
  });

  it('keeps the review script free of ${{ }} so its length cannot break it', () => {
    // This one body is ~24000 characters — already past the limit — so it stays
    // valid only while nothing templates it. Every context value it needs is
    // passed through the step's `env:` instead. A single `${{ }}` added back
    // here takes the entire workflow down, which the test above would also
    // catch; this asserts the actual invariant a contributor has to preserve.
    expect(runReviewStep()).not.toContain('${{');
  });
});

describe('command shape matching', () => {
  // A comment may be `@qwen-code /review` followed by a newline and a body.
  // The `if`s tried to accept that with format('…{0}', '\n'), but expression
  // string literals are NOT escape-processed: that '\n' is a literal
  // backslash + n, so the branch matched nothing and every multi-line command
  // was silently ignored — no run, no feedback. Measured on a live runner:
  //   startsWith(<LF body>, format('…{0}', '\n'))            => false
  //   startsWith(<LF body>, format('…{0}', fromJSON('"\n"'))) => true
  //   startsWith(<CRLF body>, format('…{0}', fromJSON('"\n"'))) => false
  //   startsWith(<CRLF body>, format('…{0}', fromJSON('"\r"'))) => true
  // Hence fromJSON (JSON *is* escape-processed) and both line endings: the
  // REST API sends LF, the web UI sends CRLF.
  const doc = parse(workflow);
  const ifs = Object.entries(doc.jobs)
    .filter(([, job]) => typeof job?.if === 'string')
    .map(([id, job]) => [id, job.if]);

  it('never matches a command shape with a non-escaped literal newline', () => {
    const broken = ifs.filter(([, cond]) => /'\\[nr]'/.test(cond));
    expect(broken.map(([id]) => id)).toEqual([]);
  });

  it('accepts both LF and CRLF after the command in every shape match', () => {
    // `authorize` deliberately matches only a loose prefix — it is a filter to
    // avoid spawning a job per comment, and delegates the exact shape to the
    // downstream jobs. Jobs that do the shape match are the ones that use
    // format('@qwen-code /<cmd>{0}', …), so key off that.
    const withShape = ifs.filter(([, cond]) =>
      cond.includes("format('@qwen-code /"),
    );
    expect(withShape.length).toBeGreaterThan(0);
    const missing = [];
    for (const [id, cond] of withShape) {
      for (const cmd of ['review', 'resolve']) {
        // Only check commands this job actually matches on.
        if (!cond.includes(`format('@qwen-code /${cmd}{0}'`)) continue;
        const lf = cond.includes(
          `format('@qwen-code /${cmd}{0}', fromJSON('"\\n"'))`,
        );
        const cr = cond.includes(
          `format('@qwen-code /${cmd}{0}', fromJSON('"\\r"'))`,
        );
        if (!lf || !cr) missing.push(`${id}/${cmd} (LF:${lf} CR:${cr})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('strips a trailing CR before parsing command tokens', () => {
    // Word splitting uses IFS, which has no CR, so a CRLF comment would carry
    // `\r` into tokens like `--timeout=300` and fail the numeric check.
    // The command is parsed in "Resolve PR context", not in "Run review".
    const run = parse(workflow).jobs['review-pr'].steps.find(
      (s) => s.id === 'context',
    ).run;
    const firstLine = run.indexOf(
      'TRIGGER_COMMAND="${TRIGGER_BODY%%$\'\\n\'*}"',
    );
    const stripCr = run.indexOf(
      'TRIGGER_COMMAND="${TRIGGER_COMMAND%$\'\\r\'}"',
    );
    expect(firstLine).toBeGreaterThan(-1);
    expect(stripCr).toBeGreaterThan(-1);
    expect(stripCr).toBeGreaterThan(firstLine);
  });
});
