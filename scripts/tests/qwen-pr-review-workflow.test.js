/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const workflowsDir = '.github/workflows';
const workflowFiles = readdirSync(workflowsDir).filter((f) =>
  /\.ya?ml$/.test(f),
);

// Single shared recipe for the review-config bot login; every suite that pins
// it reads this constant so the extraction cannot drift between call sites.
const botLogin =
  parse(workflow)
    .jobs['review-config'].steps.find((s) => s.name === 'Set review constants')
    ?.run.match(/bot_login=([A-Za-z0-9-]+)/)?.[1] ?? '';

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
function runScenario(
  scenario,
  { timeoutMinutes = 180, logPath, extraEnv = {}, armWatcher = false } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'review-retry-'));
  try {
    const bin = join(dir, 'bin');
    const attemptFile = join(dir, 'attempts');
    const durationFile = join(dir, 'durations');
    const promptFile = join(dir, 'prompts');
    writeFileSync(attemptFile, '');
    writeFileSync(durationFile, '');
    writeFileSync(promptFile, '');
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
    // The retry backoff and the watcher's poll loop are the sleeps in the
    // extraction window (a replay arms the watcher only by armWatcher
    // opt-in — see the AUTO_REVIEW pin below). The opt-in envs turn the
    // backoff into "the watcher cedes while qwen is down" and observe the
    // salvage state the watcher would poll through it.
    write(
      'sleep',
      [
        '#!/bin/bash',
        // The R4-2 witness needs the spent watcher STILL DRAINING its
        // TERM→15s→KILL wind-down when the retry branch probes it, so the
        // wind-down sleep (arg 15) really sleeps in that scenario; a
        // liveness-probed relaunch then skips it and attempt 2 runs
        // unwatched, while kill+wait reaps it and relaunches.
        'if [ "${SCENARIO:-}" = "retry_watcher_relaunch" ] && [ "${1:-}" = "15" ]; then',
        '  /bin/sleep 0.4',
        'fi',
        'if [ -n "${SUPERSEDE_DURING_BACKOFF:-}" ]; then',
        '  printf "head-b" > "$SUPERSEDE_DURING_BACKOFF"',
        'fi',
        'if [ -n "${BACKOFF_OBS:-}" ]; then',
        '  if [ -f "$SALVAGE_DIR/compose-seen" ] || [ -e "$COMPOSED_ARTIFACT" ]; then',
        '    echo present >> "$BACKOFF_OBS"',
        '  else',
        '    echo absent >> "$BACKOFF_OBS"',
        '  fi',
        'fi',
        // SLEEP_FAIL_AFTER=N exits 0 for the first N calls and 1 after:
        // `while sleep ...; do` ends the watcher's loop deterministically,
        // so an AUTO_REVIEW replay can run a watcher that never polls (the
        // extreme poll gap) without leaking a background job.
        'if [ -n "${SLEEP_FAIL_AFTER:-}" ]; then',
        '  SLC="$ATT.sleep-count"',
        '  n=$(( $(cat "$SLC" 2>/dev/null || echo 0) + 1 ))',
        '  echo "$n" > "$SLC"',
        '  [ "$n" -le "$SLEEP_FAIL_AFTER" ] || exit 1',
        'fi',
        'exit 0',
      ].join('\n') + '\n',
    );
    // The cede exits re-read the live head before trusting their marker
    // files; scripted per test (empty output = failed read / unmoved head,
    // which must NOT cede). `api` answers the timeline verification
    // (STUB_TIMELINE lines, STUB_TIMELINE_STATUS for an unavailable API).
    // STUB_LIVE_HEAD_A1 answers the FIRST pr-view call and
    // STUB_LIVE_HEAD_A2 every call from attempt 2 on, so one replay can
    // script the watcher's poll and the loop's later re-checks
    // differently.
    // The macOS lane runs this suite in BSD userland, where `date -d <ts>`
    // does not parse — supersede_reverted_during_run's timestamp read would
    // silently degrade to 0 and the replay would flip red there on every
    // run. Emulate the one GNU shape the workflow uses (fleet-shepherd's
    // gnuDateShim precedent) and pass every other call through, so the
    // coverage stays live on every lane.
    write(
      'date',
      [
        '#!/bin/bash',
        'if [ "${1:-}" = "-d" ] && [ "$#" -eq 3 ] && [ "${3:-}" = "+%s" ]; then',
        '  node -e \'const t=Date.parse(process.argv[1]);if(Number.isNaN(t))process.exit(1);console.log(Math.floor(t/1000))\' "$2"',
        'else',
        '  /bin/date "$@"',
        'fi',
      ].join('\n') + '\n',
    );
    write(
      'gh',
      [
        '#!/bin/bash',
        'if [ "${1:-}" = "api" ]; then',
        '  printf \'%s\\n\' "${STUB_TIMELINE:-}"',
        '  exit "${STUB_TIMELINE_STATUS:-0}"',
        'fi',
        'att="$(cat "$ATT" 2>/dev/null || echo 0)"',
        'if [ "$att" -ge 2 ] && [ -n "${STUB_LIVE_HEAD_A2:-}" ]; then',
        '  echo "$STUB_LIVE_HEAD_A2"',
        '  exit 0',
        'fi',
        'if [ -n "${STUB_GH_COUNT:-}" ]; then',
        '  n=$(( $(cat "$STUB_GH_COUNT" 2>/dev/null || echo 0) + 1 ))',
        '  echo "$n" > "$STUB_GH_COUNT"',
        '  if [ "$n" -eq 1 ] && [ -n "${STUB_LIVE_HEAD_A1:-}" ]; then',
        '    echo "$STUB_LIVE_HEAD_A1"',
        '    exit 0',
        '  fi',
        'fi',
        'echo "${STUB_LIVE_HEAD:-}"',
      ].join('\n') + '\n',
    );
    write(
      'qwen',
      [
        '#!/bin/bash',
        'n=$(( $(cat "$ATT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ATT"',
        // The full argv, one line per attempt, with the boundaries INTACT:
        // `$*` would join on spaces and render `--prompt "/review x --resume"`
        // identically to `--prompt "/review x" --resume`, which are different
        // wirings — the second reaches the root CLI's own session-resume flag
        // and the skill never sees it.
        'printf "%s\\n" "$(printf "<%s>" "$@")" >> "$PRM"',
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
        '  supersede_mid_attempt) r success false "[API Error: 503 upstream overloaded]"; printf "head-b\\n::error::injected forged annotation" > "$SUPERSEDE_FILE" ;;',
        // Hostile salvage-state shapes during a retryable attempt 1 (the
        // reviewed agent derives every path from its exported environment):
        // planted DIRECTORIES at the signal names (rm -f would abort the
        // reset under errexit) and a deleted SALVAGE_DIR (the attempt-start
        // rewrite must not abort it either). Attempt 2 must run and win.
        '  retry_planted_dirs) if [ "$n" -eq 1 ]; then mkdir -p "$SALVAGE_DIR/compose-seen" "$SALVAGE_DIR/moved-to" "$SALVAGE_DIR/salvage-ok" "$COMPOSED_ARTIFACT"; [ -z "${SUPERSEDE_FILE:-}" ] || mkdir -p "$SUPERSEDE_FILE"; r success false "[API Error: 503 upstream overloaded]"; else r success false "ok after hostile reset"; fi ;;',
        '  retry_deleted_salvage_dir) if [ "$n" -eq 1 ]; then rm -rf "$SALVAGE_DIR"; r success false "[API Error: 503 upstream overloaded]"; else r success false "ok after salvage dir vanished"; fi ;;',
        // The watcher arms the salvage marker mid-attempt (simulated here by
        // the stub, since the replayed watcher can only CEDE without an
        // injected salvage_eligible) and the attempt still dies retryable.
        '  salvage_armed_then_die) printf "head-a" > "$QWEN_CI_REVIEW_SALVAGE_OK_FILE"; r success false "[API Error: 503 upstream overloaded]" ;;',
        '  supersede_forge_mid_attempt) printf "head-b" > "$SUPERSEDE_FILE"; r success false "Reviewed." ;;',
        '  supersede_during_backoff) if [ "$n" -eq 1 ]; then r success false "[API Error: 503 upstream overloaded]"; else r success false "attempt 2 must not run"; fi ;;',
        '  compose_then_backoff_supersede) if [ "$n" -eq 1 ]; then : > "$SALVAGE_DIR/compose-seen"; printf "{}" > "$COMPOSED_ARTIFACT"; r success false "[API Error: 503 upstream overloaded]"; else r success false "attempt 2 must not run"; fi ;;',
        '  supersede_after_success) printf "head-b" > "$SUPERSEDE_FILE"; r success false "Reviewed." ;;',
        '  cede_revert_kill) exit 143 ;;',
        '  retry_watcher_relaunch) if [ "$n" -eq 1 ]; then r success false "[API Error: 503 upstream overloaded]"; else i=0; until [ -f "$SUPERSEDE_FILE" ] || [ "$i" -ge 200 ]; do /bin/sleep 0.05; i=$((i+1)); done; r success false "[API Error: 503 upstream overloaded]"; fi ;;',
        '  retry_clears_stale_signals) if [ "$n" -eq 1 ]; then r success false "[API Error: 503 upstream overloaded]"; else { [ -f "$SUPERSEDE_FILE" ] && echo present || echo absent; } >> "$OBS"; r success false "ok"; fi ;;',
        '  compose_latch_reset) if [ "$n" -eq 1 ]; then r success false "[API Error: 503 upstream overloaded]"; : > "$SALVAGE_DIR/compose-seen"; else { [ -f "$SALVAGE_DIR/compose-seen" ] && echo present || echo absent; } >> "$OBS"; r success false "[API Error: 503 upstream overloaded]"; fi ;;',
        '  compose_artifact_reset) if [ "$n" -eq 1 ]; then printf \'{"downgraded":false}\' > "$COMPOSED_ARTIFACT"; r success false "[API Error: 503 upstream overloaded]"; else { [ -e "$COMPOSED_ARTIFACT" ] && echo present || echo absent; } >> "$OBS"; r success false "ok"; fi ;;',
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
      // The retry loop keeps per-attempt salvage state here; exported so
      // the stub qwen can simulate the watcher's compose latch.
      `SALVAGE_DIR="${join(dir, 'salvage')}"; mkdir -p "$SALVAGE_DIR"; export SALVAGE_DIR`,
      `COMPOSED_ARTIFACT="${join(dir, 'composed.json')}"; export COMPOSED_ARTIFACT`,
      'fail(){ echo "FAIL kind=[${3:-}] reason=[$1]"; exit "${2:-1}"; }',
      retryLoopSource(),
      'echo "OK outcome=$OUTCOME"',
    ].join('\n');
    let stdout = '';
    let timedOut = false;
    let status = 0;
    try {
      stdout = execFileSync('bash', ['-c', harness], {
        encoding: 'utf8',
        // A planted-FIFO regression blocks the child instead of failing
        // it; the bound turns the hang into a red test.
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SCENARIO: scenario,
          ATT: attemptFile,
          DUR: durationFile,
          PRM: promptFile,
          ...(armWatcher
            ? {
                // The watcher polls and pkills with these; the stubs make
                // every call inert except the decision itself.
                PR_NUMBER: '1',
                REPO: 'o/r',
                REVIEW_URL: 'zz-no-such-review-url',
                DOCS_ONLY_MEDIUM: 'false',
                SALVAGE_ELAPSED_PERCENT: '50',
              }
            : {}),
          ...extraEnv,
          // The extraction window contains the watcher's AUTO_REVIEW-gated
          // arming and the spread above inherits the parent environment, so
          // pin AFTER it: an exported AUTO_REVIEW=true (this workflow's own
          // review lane exports one) would arm a watcher with no REPO to
          // poll and hang every replay. The production arming stays pinned
          // by the shape tests; a replay arms it only by armWatcher opt-in,
          // with the stub environment above.
          AUTO_REVIEW: armWatcher ? 'true' : 'false',
          // The step initializes PROXY_BIN before the retry loop and the
          // agent invocation's decoy GITHUB_PATH/GITHUB_ENV wiring expands
          // it; the extraction starts at OUTCOME='', past the init, so the
          // harness must supply it (set -u would otherwise abort the loop).
          PROXY_BIN: join(dir, 'proxy-bin'),
        },
      });
    } catch (e) {
      if (`${e?.error?.code ?? ''}` === 'ETIMEDOUT') {
        timedOut = true;
      } else {
        stdout = `${e.stdout ?? ''}`;
        // The cede exits are load-bearing clean — a non-zero cede opens
        // the failure-fallback gate — so a swallowed exit code would
        // hide the regression this harness exists to catch.
        status = e.status ?? 1;
      }
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
      prompts: readFileSync(promptFile, 'utf8').split('\n').filter(Boolean),
      timedOut,
      status,
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
    // The arithmetic lives in ONE function shared by the docs-only branch
    // and the micro tightening; extract the definition plus one call, so
    // these cases execute the same implementation both branches run.
    const start = run.indexOf('halve_budget_floor() {');
    const endAnchor = '\n}';
    const end = run.indexOf(endAnchor, start) + endAnchor.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return `${run.slice(start, end)}\nhalve_budget_floor`;
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

  function runGate({ autoReview, wrapper, prSizeLines, timeoutMinutes }) {
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
        `EFFECTIVE_TIMEOUT_MINUTES=${timeoutMinutes ?? 360}`,
        ...(prSizeLines === undefined ? [] : [`PR_SIZE_LINES=${prSizeLines}`]),
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

  it("tightens a micro diff's budget without touching its effort or posting", () => {
    // Below the independent churn bound (25 changed lines — NOT the skill's
    // SWEEP_FLOOR, which weighs source/unified-diff lines) the automatic run
    // keeps --effort high and its inline comments — only the kill switch
    // halves, to the same 90-minute floor the docs downgrade uses.
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho full\n',
      prSizeLines: 24,
      timeoutMinutes: 180,
    });
    expect(r.output).toBe('docs_only_medium=false');
    expect(r.stdout).toContain('micro diff (24 changed lines)');
    expect(r.stdout).toContain('keeps --effort high');
    expect(r.stdout).toContain('timeout=90');
  });

  it('micro tightening floors at 90 minutes', () => {
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho full\n',
      prSizeLines: 10,
      timeoutMinutes: 100,
    });
    expect(r.stdout).toContain('timeout=90');
  });

  it('twenty-five changed lines is not micro — the boundary of the churn bound', () => {
    // The 25 is an independent "small PR" churn bound (NOT the skill's
    // SWEEP_FLOOR — the two measures differ, so a scattered micro diff may
    // still run the sweep); the tightening is justified by "90 min is ample
    // for churn < 25 work", not by the pipeline shrinking. 25 itself must
    // not tighten.
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho full\n',
      prSizeLines: 25,
      timeoutMinutes: 180,
    });
    expect(r.stdout).not.toContain('micro diff');
    expect(r.stdout).toContain('timeout=180');
  });

  it('both downgrades share one halve-with-floor implementation', () => {
    // Two verbatim copies once let a one-sided divisor edit diverge micro
    // runs from docs-only runs while the comments claimed they matched —
    // probe: a / 2 → / 3 mutant survived every test because both micro
    // inputs land on the floor under any divisor ≥ 2. One named function,
    // called from both branches, makes the invariant structural.
    const gate = gateSource();
    expect(gate.match(/halve_budget_floor\(\)/g)).toHaveLength(1);
    expect(gate.match(/halve_budget_floor$/gm)).toHaveLength(2);
    expect(
      gate.match(
        /EFFECTIVE_TIMEOUT_MINUTES=\$\(\( EFFECTIVE_TIMEOUT_MINUTES \/ 2 \)\)/g,
      ),
    ).toHaveLength(1);
  });

  it('a docs-only micro diff is halved once, by the docs gate, not twice', () => {
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho docs_only\n',
      prSizeLines: 10,
      timeoutMinutes: 360,
    });
    expect(r.output).toBe('docs_only_medium=true');
    expect(r.stdout).toContain('timeout=180');
    expect(r.stdout).not.toContain('micro diff');
  });

  it('a manually requested review is never tightened, whatever its size', () => {
    // Production-reachable: an @qwen-code /review comment without --timeout
    // populates PR_SIZE_LINES but is not an automatic review — its budget
    // is the caller's. A mutant dropping the AUTO_REVIEW guard survived the
    // suite until this pin.
    const r = runGate({
      autoReview: 'false',
      wrapper: '#!/bin/bash\necho full\n',
      prSizeLines: 10,
      timeoutMinutes: 180,
    });
    expect(r.stdout).not.toContain('micro diff');
    expect(r.stdout).toContain('timeout=180');
  });

  it('a failed docs classification still tightens a micro automatic run', () => {
    // DOCS_ONLY_MEDIUM stays '' when the classifier fails; the micro guard
    // keys on != "true", not = "false" — a mutant conflating the two kept
    // 180 on exactly the runs the tightening exists for.
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\nexit 2\n',
      prSizeLines: 10,
      timeoutMinutes: 180,
    });
    expect(r.output).toBe('docs_only_medium=');
    expect(r.stdout).toContain('micro diff (10 changed lines)');
    expect(r.stdout).toContain('timeout=90');
  });

  it('an unknown size never tightens — and neither does an explicit run', () => {
    // PR_SIZE_LINES is unset when the size lookup failed or when the caller
    // passed --timeout (the size block is skipped); both must keep the
    // budget they have.
    const r = runGate({
      autoReview: 'true',
      wrapper: '#!/bin/bash\necho full\n',
      timeoutMinutes: 180,
    });
    expect(r.stdout).not.toContain('micro diff');
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

  it('keeps every templated run block under the limit', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    const over = [];
    for (const file of workflowFiles) {
      const doc = parse(readFileSync(join(workflowsDir, file), 'utf8'));
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

describe('bot comment markers', () => {
  // A line that opens with `<!--` starts an HTML block, and that block runs to
  // the line holding the closing delimiter INCLUSIVE — the rest of that line
  // stays inside it and is never parsed as Markdown. The queued-ack comment
  // glued its prose straight onto the marker and reached every PR as raw
  // source with a dead link. Measured through GitHub's own renderer
  // (POST /markdown, mode=gfm): marker+text -> 0 <a>/0 <em>; marker+"\n"+text
  // and marker+"\n\n"+text -> 1 <a>/1 <em>.
  //
  // The rule keys off ONE thing: a marker that opens a string literal, and
  // what remains inside that literal after it. That is what distinguishes
  // BUILDING a comment body from merely REFERENCING a marker — `jq
  // contains("<!-- m -->")` and `printf '<!-- m -->' "$VAR"` leave nothing
  // after the marker and are fine, while `="<!-- m -->prose"` does not. The
  // scan is bounded to the marker's physical line: a glued body is by
  // definition on that line, and searching past it would couple the guard to
  // unrelated quotes elsewhere in the file — a doc example quoting an unclosed
  // `--body "<!-- m -->` would break the moment any later line gained a `"`.
  //
  // Known gaps, stated rather than papered over: bodies split across printf
  // arguments (`printf '%s%s' '<!-- m -->' 'prose'`) — detecting them means
  // modelling which literal is the format string, and every cheap
  // approximation flagged the legitimate `printf '<!-- m -->' "$VAR"` form;
  // bodies assembled across statements or files (one `echo` per line into a
  // `--body-file`); markers at physical line start (heredocs, YAML block
  // scalars); markers mid-literal that only land at a rendered line start
  // after `\n` expansion (`printf 'x\n<!-- m -->prose'`); multi-line literals
  // whose closing quote sits on a later line; a line-wrapped printf whose
  // format opens with the marker (the `\n` exemption reads one physical
  // line); continuations after a marker-ending literal other than an
  // adjacent quoted literal or bare `$(…)` — `$VAR` expansion, unquoted
  // words, `$'…'` literals, backtick substitution, backslash-newline, and
  // text after the closing `)` of a wrapping subshell assignment
  // (`BODY="$(printf '<!-- m -->')prose"`); closing that shape needs a
  // subshell discriminator that false-positives on legitimate jq
  // `contains("<!-- … -->"))` references inside `$(…)` assignments;
  // trailing end-of-line comments — the `#` skip only fires when the
  // comment OPENS the physical line, so a glued marker quoted in a
  // trailing comment is still flagged; YAML double-quoted scalars
  // (`body: "<!-- m -->\nprose"`) — YAML expands `\n`, but the scanner
  // cannot cheaply tell a YAML scalar from a shell literal where `\n`
  // stays literal; and marker-headed bodies built outside
  // `.github/workflows` — the `.github/scripts/*.mjs` comment builders
  // (template literals and pushed marker lines) are not scanned. All are
  // latent — nothing glues a marker today.

  it('never glues prose onto a comment marker, in any workflow', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    const offenders = [];
    for (const file of workflowFiles) {
      const text = readFileSync(join(workflowsDir, file), 'utf8');
      // The class excludes `\n` so a `<!--` inside a nearby comment cannot
      // let one match span lines, swallow the real marker, and get discarded
      // by the comment skip below — the guard would then pass with the very
      // regression present. `>` stays allowed inside a marker (lazy match to
      // the first `-->` on the line) so arrow-style markers are covered too.
      const re = /<!--[^\n]*?-->/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const prefix = text.slice(lineStart, m.index);
        // Prose in a YAML or shell comment never reaches a comment body.
        if (/^\s*#/.test(prefix)) continue;
        const quote = m.index === lineStart ? null : text[m.index - 1];
        // Only a marker that OPENS a string literal can be building a body.
        if (quote !== "'" && quote !== '"') continue;
        const rest = text.slice(m.index + m[0].length);
        const lineEnd = rest.indexOf('\n');
        const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
        const end = line.indexOf(quote);
        // No closing quote on this line means either the marker ends the line
        // inside a multi-line literal (a real newline separates the body,
        // which renders) or the quote is prose in a doc example — neither
        // glues anything ON the marker's line.
        if (end === -1) continue;
        let glued = line.slice(0, end);
        if (glued === '') {
          // The literal ended at the marker — but an adjacent literal on the
          // same line concatenates onto it at runtime, and so does an
          // unquoted `$(…)` (its output is invisible to this scan).
          const after = line.slice(end + 1);
          if (after[0] === "'" || after[0] === '"') {
            const q2 = after[0];
            const e2 = after.slice(1).indexOf(q2);
            glued = e2 === -1 ? '' : after.slice(1, 1 + e2);
          } else if (after[0] === '$' && after[1] === '(') {
            glued = after;
          }
        }
        if (glued === '') continue;
        // The two-character `\n` escape separates only where the shell
        // expands it: a printf format string or ANSI-C `$'…'` opened at the
        // END of the prefix — an unrelated printf earlier on the same line
        // must not bless a plain double-quoted assignment, where `\n` stays
        // a literal backslash-n and the prose stays on the marker's line.
        if (
          glued.startsWith('\\n') &&
          /printf\s+(?:-\S+\s+(?:\S+\s+)?|--\s+)?['"]$|\$'$/.test(prefix)
        ) {
          continue;
        }
        offenders.push(
          `${file}: ${text.slice(m.index, m.index + 56).split('\n')[0]}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pins the workflow-run URL into the ack printf', () => {
    // bash printf with a leftover argument and no conversion spec exits 0
    // under `set -euo pipefail` and emits `[workflow run]()`, so nothing
    // else catches a dropped `%s` or `"$RUN_URL"` on the ack line. Assert
    // the link shape, not bare co-existence: a `%s` displaced out of the
    // parens keeps both pieces on the line and re-ships the dead link.
    const ackLine = workflow
      .split('\n')
      .find(
        (l) => l.includes('printf') && l.includes('<!-- qwen-review-ack -->'),
      );
    expect(ackLine).toBeDefined();
    expect(ackLine).toContain('[workflow run](%s)');
    expect(ackLine).toContain('"$RUN_URL"');
  });
});

describe('qwen pr review concurrency routing', () => {
  // A PENDING run in a concurrency group is replaced by any newer run of the
  // same group — cancel-in-progress does not protect it. On PR #9091 a push
  // and three human review requests landed in the same minute: the
  // synchronize run cancelled the in-flight review but queued behind it while
  // it terminated, and the review_requested runs — no-ops, since review-pr
  // only runs when the bot itself is the requested reviewer — superseded it
  // while pending. The sole survivor skipped review-pr, so the push was never
  // reviewed. Routing only the human-requested siblings to a per-run group
  // leaves the race open: group membership is fixed here, before `authorize`
  // runs, but whether a bot-directed request reviews anything is `authorize`'s
  // call on the REQUESTER's write permission — a requester without write
  // produces a guaranteed all-skipped run, and as a shared-group member that
  // no-op can supersede the pending lifecycle run, losing the review the same
  // way. Every review_requested run therefore gets a per-run group; an
  // authorized bot request still reviews immediately, it just can no longer
  // supersede the lifecycle run for the same head.
  const group = parse(workflow).concurrency.group;

  it('keeps every review_requested run out of the shared PR group', () => {
    // Verbatim, like the cancel-in-progress pin in the resolve suite: the
    // shape IS the fix — `&&` binds tighter than `||`, so exactly the
    // lifecycle actions reach the PR group and every review_requested (bot
    // included) falls through to the per-run group. Any requested_reviewer
    // clause here re-admits the unauthorized-requester no-op and silently
    // re-ships the race.
    expect(group).toBe(
      "${{ github.event_name == 'pull_request_target' && " +
        "github.event.action != 'review_requested' && " +
        "format('qwen-pr-review-pr-{0}', github.event.pull_request.number) || " +
        "format('qwen-pr-review-run-{0}', github.run_id) }}",
    );
  });

  it('gates the review_requested jobs on the published bot login', () => {
    // The group expression no longer names the requested reviewer; the
    // job-level gates still must. Pin the surviving literal against the
    // review-config constant so a bot rename cannot desync the sites.
    expect(parse(workflow).jobs['precheck-pr'].if).toContain(
      `github.event.requested_reviewer.login == '${botLogin}'`,
    );
  });
});

describe('review_requested burst coalescing (#8945)', () => {
  // Opening a same-repo PR that touches CODEOWNERS-covered paths auto-requests
  // every owner individually, so one PR open emits one `review_requested` run
  // per owner (observed: five within the same second on #8830/#9142). Only
  // the bot-requested run can reach `review-pr`; the human-requested siblings
  // used to spend an `authorize` job (permission API + runner slot) each
  // before no-op exiting. `authorize` and `review-config` must filter those
  // siblings at the job level so they complete as instant all-skipped runs.
  const doc = parse(workflow);

  const botRequestedClause = new RegExp(
    [
      String.raw`\(\s*github\.event_name != 'pull_request_target' \|\|`,
      String.raw`\s*github\.event\.action != 'review_requested' \|\|`,
      String.raw`\s*github\.event\.requested_reviewer\.login == '${botLogin}'\s*\)`,
    ].join(''),
  );

  it('resolves the bot login from review-config, not a paraphrase', () => {
    expect(botLogin).toBe('qwen-code-ci-bot');
  });

  it('filters non-bot review_requested events before authorize spends compute', () => {
    // The same disjunction precheck-pr already applies to fork PRs; mirroring
    // it here covers same-repo PRs, which precheck-pr deliberately skips.
    expect(doc.jobs['authorize'].if).toMatch(botRequestedClause);
  });

  it('keeps review-config from running for non-bot review_requested events', () => {
    // review-config exists to feed bot_login into review-pr; only the
    // bot-requested run can get there, so every other sibling is pure waste.
    const cond = doc.jobs['review-config'].if;
    expect(cond).toContain("github.event.action == 'review_requested'");
    expect(cond).toContain(
      `github.event.requested_reviewer.login == '${botLogin}'`,
    );
  });
});

describe('qwen pr review retry runs fresh (no --resume)', () => {
  // `--resume` is a local convenience only. On CI each retry re-runs the whole
  // review from scratch: the attempt runs no-sandbox and its worktree is
  // deleted the moment it exits, so there is no interrupted state on disk for
  // a next attempt to continue. Probe-verified: appending `--resume` on the
  // retry (the earlier wiring) shipped green before this assertion existed.
  it('every attempt gets the verbatim prompt, none carries --resume', () => {
    const r = runScenario('transient_then_success');
    expect(r.attempts).toBe(2);
    expect(r.prompts).toHaveLength(2);
    // One argv element per <>, so a stray `--resume` token — whether inside
    // the prompt value or as its own argument after it — would be visible
    // here rather than hidden by space-joining.
    expect(r.prompts[0]).toContain('<--prompt></review x>');
    expect(r.prompts[1]).toContain('<--prompt></review x>');
    expect(r.prompts.join('\n')).not.toContain('--resume');
  });

  it('a single successful attempt never carries --resume', () => {
    const r = runScenario('success');
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).not.toContain('--resume');
  });
});

describe('checkout self-heal', () => {
  // The reused self-hosted pool fails checkout in two observed shapes: a
  // transient network drop mid-fetch, and a corrupt persisted workspace
  // whose refs claim objects missing from its object store — then EVERY
  // later fetch dies in negotiation with "remote did not send all necessary
  // objects" (ecs-qwen-runner-64c-23, 2026-08-13..15: seven review jobs
  // dead on the same missing SHAs). The workspace cannot heal itself, so
  // the workflow must: survive the first failure, wipe, and re-clone.
  // GITHUB_WORKSPACE is set by actions/runner, so these tests pin the heal
  // chain's behavior — wipe, sudo leg, never-fail exit, identical retry —
  // not guards against runner-mangled paths.
  const steps = parse(workflow).jobs['review-pr'].steps;
  const FIRST = 'Checkout base branch';
  const WIPE = 'Reset workspace after failed checkout';
  const RETRY = 'Checkout base branch (retry)';
  const nameIndex = (name) => steps.findIndex((s) => s.name === name);
  const first = steps[nameIndex(FIRST)];
  const wipe = steps[nameIndex(WIPE)];
  const retry = steps[nameIndex(RETRY)];
  // Runs the real wipe script under the runner's shell flags: GitHub Actions
  // executes `run:` blocks with `-eo pipefail`, and that implicit errexit is
  // what kills a heal step ending on a nonzero status in production, so the
  // exec tests must reproduce it instead of hiding it behind bare `bash -c`.
  const runWipe = (env, options = {}) =>
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', wipe.run], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      ...options,
    });

  it('makes the first checkout failure survivable and addressable', () => {
    // Without continue-on-error the job dies on the first failure and the
    // heal chain never runs; without the id the chain cannot gate on the
    // outcome at all.
    expect(first.id).toBe('checkout');
    expect(first['continue-on-error']).toBe(true);
    // Symmetric half of the invariant: a double checkout failure must stay
    // red so the job never proceeds into review without code.
    expect(retry['continue-on-error']).toBeUndefined();
    // The wipe step gets no continue-on-error either: its deliberate nonzero
    // exits are the `:?` abort on a dropped GITHUB_WORKSPACE and the
    // plain-directory refusal, both of which must fail the job loud rather
    // than degrade to a log annotation.
    expect(wipe['continue-on-error']).toBeUndefined();
  });

  it('wipes and retries exactly when the first checkout fails', () => {
    expect(wipe).toBeDefined();
    expect(retry).toBeDefined();
    const gate = "steps.checkout.outcome == 'failure'";
    expect(wipe.if).toBe(gate);
    expect(retry.if).toBe(gate);
    expect(nameIndex(FIRST)).toBeLessThan(nameIndex(WIPE));
    expect(nameIndex(WIPE)).toBeLessThan(nameIndex(RETRY));
  });

  it('retries with the identical checkout', () => {
    // A drift here silently changes what the review runs against — dropping
    // fetch-depth on the retry would hand the review a shallow clone. The
    // equality checks alone cannot catch a coordinated drift of BOTH steps,
    // so the first checkout is pinned to its required absolute values too.
    expect(retry.uses).toBe(first.uses);
    expect(retry.with).toEqual(first.with);
    expect(first.uses).toBe(
      'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
    );
    expect(first.with.ref).toBe(
      '${{ github.event.repository.default_branch }}',
    );
    expect(first.with['fetch-depth']).toBe(0);
  });

  it('wipes the whole workspace, hidden entries included', () => {
    // Executes the REAL wipe script against a disposable workspace: it must
    // remove the directory contents (not just .git — a hostile tree must not
    // trip the re-clone) and leave the directory itself behind for the
    // retry. Hidden entries are the regression case: a glob-shaped wipe
    // skips dotfiles and would leave exactly the .git this heal exists to
    // remove.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-heal-')));
    try {
      mkdirSync(join(dir, 'leftover-dir'));
      writeFileSync(join(dir, 'leftover'), 'x');
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'HEAD'), 'x');
      const out = runWipe({ GITHUB_WORKSPACE: dir });
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
      // The clean wipe must stay silent about survivors: the warning is the
      // oncall signal for a poisoned workspace, and a guard-less script
      // emitting an empty-list survivor warning on EVERY heal dilutes
      // exactly that signal while shipping green.
      expect(out).toContain('wiped the workspace');
      expect(out).not.toContain('workspace wipe left survivors');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Fronts PATH with a `sudo` stub so the sudo leg behaves identically on
  // every lane: the real pool splits between members WITH passwordless sudo
  // (the leg runs as root) and members without it (the leg dies with "a
  // password is required"), so a test leaning on the real sudo silently
  // covers a different branch on each machine.
  const stubSudo = (exitCode, markerPath) => {
    const bin = mkdtempSync(join(tmpdir(), 'checkout-heal-bin-'));
    const body = markerPath
      ? `#!/bin/sh\nprintf '%s\\n' "$@" >> '${markerPath}'\nexit ${exitCode}\n`
      : `#!/bin/sh\nexit ${exitCode}\n`;
    writeFileSync(join(bin, 'sudo'), body);
    chmodSync(join(bin, 'sudo'), 0o755);
    return bin;
  };

  // A workspace whose entries the owning user cannot unlink: find -exec rm
  // exits nonzero, so the user-mode wipe leg fails deterministically. Root
  // bypasses the 0o500 lock via CAP_DAC_OVERRIDE, so the tests built on it
  // skip there, and win32 has no POSIX permission bits to honor.
  const lockFixture = () => {
    const parent = realpathSync(
      mkdtempSync(join(tmpdir(), 'checkout-heal-lock-')),
    );
    const dir = join(parent, 'workspace');
    mkdirSync(dir);
    writeFileSync(join(dir, 'leftover'), 'x');
    chmodSync(dir, 0o500);
    return { parent, dir };
  };
  const unlock = ({ parent, dir }) => {
    chmodSync(dir, 0o755);
    rmSync(parent, { recursive: true, force: true });
  };

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'exits 0 and keeps survivors when BOTH wipe legs fail',
    () => {
      // The wipe step has no continue-on-error, so its own never-fail exit
      // contract is what keeps the heal chain alive: a permission-blocked
      // wipe must warn and exit 0 so the retry checkout still runs, with
      // the survivors left in place — the retry runs against them, and a
      // double checkout failure is what turns the job red. The stubbed sudo
      // makes the else branch reachable even on lanes with passwordless
      // sudo, and both else-branch signals must fire: the wipe-failed
      // warning, and the survivor warning naming them so oncall can tell
      // what poisoned the workspace.
      const fixture = lockFixture();
      const bin = stubSudo(1);
      try {
        const out = runWipe({
          GITHUB_WORKSPACE: fixture.dir,
          PATH: `${bin}:${process.env.PATH}`,
        }); // must not throw
        expect(readdirSync(fixture.dir)).toContain('leftover');
        expect(out).toContain('could not wipe the workspace');
        expect(out).toContain('workspace wipe left survivors');
        expect(out).toContain('leftover');
      } finally {
        unlock(fixture);
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'escalates to the sudo leg when the user-mode wipe fails',
    () => {
      // Deleting the `|| sudo -n find …` leg (or flipping it to `&&`) must
      // turn this red: the marker only appears when the sudo leg actually
      // runs, and its recorded argv must target the workspace — a refactor
      // drifting the leg's path shipped green before the argv was pinned.
      // The stub exits 0 without removing anything, so the then-branch is
      // pinned without depending on any real sudo.
      const fixture = lockFixture();
      const marker = join(fixture.parent, 'sudo-called');
      const bin = stubSudo(0, marker);
      try {
        runWipe({
          GITHUB_WORKSPACE: fixture.dir,
          PATH: `${bin}:${process.env.PATH}`,
        });
        expect(existsSync(marker)).toBe(true);
        // Exact argv entry, not substring: a drifted target like
        // "$WS/does-not-exist" still CONTAINS the workspace path.
        expect(readFileSync(marker, 'utf8').split('\n')).toContain(fixture.dir);
      } finally {
        unlock(fixture);
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  it('refuses to wipe when GITHUB_WORKSPACE is unset or empty', () => {
    // The `:?` guard is what keeps this from ever running rm against a
    // surprise expansion; a dropped GITHUB_WORKSPACE must fail loudly.
    expect(() =>
      runWipe({ GITHUB_WORKSPACE: '' }, { stdio: 'pipe' }),
    ).toThrow();
  });

  it('refuses a redirected workspace instead of silently wiping nothing', () => {
    // The `:?` guard validates the string, not the filesystem object: find
    // -P does not descend a symlinked start, so a workspace redirected
    // through a symlink would make the wipe log success and delete nothing
    // — then the secret-bearing review step runs through the redirection.
    // A legitimate workspace is always a runner-created plain directory, so
    // the refusal costs nothing; the link target must survive it untouched.
    const parent = realpathSync(
      mkdtempSync(join(tmpdir(), 'checkout-heal-link-')),
    );
    const target = join(parent, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'victim'), 'x');
    const ws = join(parent, 'workspace');
    symlinkSync(target, ws);
    try {
      expect(() =>
        runWipe({ GITHUB_WORKSPACE: ws }, { stdio: 'pipe' }),
      ).toThrow();
      expect(readdirSync(target)).toContain('victim');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a workspace redirected through an intermediate symlink', () => {
    // `[ -L ]` lstats only the final component and `[ -d ]` follows
    // intermediate links, so a workspace whose PARENT is a symlink passes
    // both — and find then deletes the redirect target's contents OUTSIDE
    // the runner workspace while logging a successful wipe. The guard must
    // validate the resolved path, not just the last component; the victim
    // under the redirect target must survive the refusal untouched.
    const parent = realpathSync(
      mkdtempSync(join(tmpdir(), 'checkout-heal-midlink-')),
    );
    const target = join(parent, 'target');
    mkdirSync(target);
    mkdirSync(join(target, 'workspace'));
    writeFileSync(join(target, 'workspace', 'victim'), 'x');
    symlinkSync(target, join(parent, 'repo'));
    const ws = join(parent, 'repo', 'workspace');
    try {
      expect(() =>
        runWipe({ GITHUB_WORKSPACE: ws }, { stdio: 'pipe' }),
      ).toThrow();
      expect(readdirSync(join(target, 'workspace'))).toContain('victim');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a non-directory workspace instead of wiping nothing', () => {
    // The symlink tests short-circuit at the resolved-path check, leaving
    // the `[ ! -d ]` disjunct unpinned: a plain file at the workspace path
    // must hit the same loud refusal, because find on a non-directory
    // matches nothing and the step would log a successful wipe while
    // deleting nothing.
    const parent = realpathSync(
      mkdtempSync(join(tmpdir(), 'checkout-heal-file-')),
    );
    const file = join(parent, 'workspace');
    writeFileSync(file, 'x');
    try {
      expect(() =>
        runWipe({ GITHUB_WORKSPACE: file }, { stdio: 'pipe' }),
      ).toThrow();
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a nonexistent workspace instead of exiting 0 unwiped', () => {
    // A missing path takes the same `[ ! -d ]` disjunct as a plain file,
    // but a guard mutated to `[ -f ]` would still refuse the file while
    // letting the missing path through: both wipe legs then fail on the
    // absent start point and the step exits 0 into a retry that fails
    // again — the refusal must stay loud for this shape too.
    const missing = join(
      realpathSync(tmpdir()),
      'checkout-heal-missing',
      'workspace',
    );
    expect(() =>
      runWipe({ GITHUB_WORKSPACE: missing }, { stdio: 'pipe' }),
    ).toThrow();
  });

  it('seals every override channel into the wipe step', () => {
    // With the allowlist gone, the runner-set GITHUB_WORKSPACE is the
    // wipe's only path input and the `find … -exec rm -rf` is unguarded,
    // so this premise carries the whole safety story. Sealed here are the
    // channels that DO propagate into the wipe step: declarative `env:`
    // entries at workflow, job, and wipe-step scope (step-local blocks on
    // earlier steps die with their step), matched by dangerous name class
    // because a named list can never enumerate the surface; `$GITHUB_PATH`
    // and `$GITHUB_ENV` writes in pre-wipe run blocks — bare and braced
    // spellings, plus the legacy `::set-env::` / `::add-path::` forms that
    // ACTIONS_ALLOW_UNSECURE_COMMANDS re-enables; the pre-wipe action set,
    // because a `uses:` step's runtime core.addPath / core.exportVariable
    // writes have no run text to scan; and the shell selection, because a
    // wipe-step `shell:` or a workflow/job `defaults:` wrapper re-targets
    // the step's environment at exec time. `export` in a run block dies at
    // the step boundary, and `$GITHUB_ENV` writes of runtime-context names
    // (e.g. GITHUB_WORKSPACE) are overwritten when the runner re-applies
    // its runtime environment at step setup, so neither is checked here.
    const doc = parse(workflow);
    const dangerousEnv = (name) =>
      /^(GITHUB_WORKSPACE|PATH|BASH_ENV|CDPATH|ENV|SHELLOPTS|ACTIONS_ALLOW_UNSECURE_COMMANDS)$/.test(
        name,
      ) ||
      name.startsWith('LD_') ||
      name.startsWith('BASH_FUNC_');
    for (const scope of [doc.env, doc.jobs['review-pr'].env, wipe.env]) {
      expect(Object.keys(scope ?? {}).filter(dangerousEnv)).toEqual([]);
    }
    expect(wipe.shell).toBeUndefined();
    expect(doc.defaults?.run?.shell).toBeUndefined();
    expect(doc.jobs['review-pr'].defaults?.run?.shell).toBeUndefined();
    for (const step of steps.slice(0, nameIndex(WIPE))) {
      if (step.uses !== undefined) {
        expect(step.uses).toBe(
          'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
        );
      }
      expect(step.run ?? '').not.toMatch(/\$\{?GITHUB_(ENV|PATH)\b/);
      expect(step.run ?? '').not.toMatch(/::(set-env|add-path)::/);
    }
  });
});

describe('fallback comment resilience (PR #8894 incident class)', () => {
  // The health-probe fail-fast, the fallback-comment job, and the cross-job
  // marker dedup are the incident's three defenses; reverting any hunk must
  // fail here, since nothing outside this workflow references the marker.
  const doc = parse(workflow);
  const job = doc.jobs['fallback-comment'];
  const step = job.steps.find((s) => s.name === 'Post fallback comment');
  const inJobStep = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Post fallback comment on failure',
  );
  const health = doc.jobs['review-pr'].steps.find(
    (s) => s.name === 'Verify runner directory health',
  );
  const marker = doc.env?.FALLBACK_MARKER;

  it('defines the fallback marker once and every site references the env', () => {
    expect(marker).toBe('<!-- qwen-review-fallback -->');
    // Both comment bodies are built from the variable, and the dedup filter
    // interpolates it — a hardcoded copy surviving in any run block could be
    // renamed on one side only, silently breaking cross-job dedup.
    expect(inJobStep.run).toContain(`printf '%s\\n\\n%s' "$FALLBACK_MARKER"`);
    expect(step.run).toContain(`printf '%s\\n\\n%s' "$FALLBACK_MARKER"`);
    expect(step.run).toContain('contains(\\"$FALLBACK_MARKER\\")');
    for (const run of [inJobStep.run, step.run, health.run]) {
      expect(run).not.toContain('<!-- qwen-review-fallback -->');
    }
  });

  it('keeps every failure body linked to the run and marker-prepended', () => {
    // All four FAILURE_KIND bodies carry the workflow-logs link — dropping it
    // from a variant ships a dead-end comment on exactly that failure path.
    expect(
      inJobStep.run.match(/See \[workflow logs\]\(\$\{RUN_URL\}\)\./g),
    ).toHaveLength(4);
    // Same invariant for the fallback job's TWO bodies (failure and
    // cancelled): the cross-job dedup matches `actions/runs/<id>)`, anchored
    // on the markdown link's closing paren — a body that rendered the URL
    // differently would escape it.
    expect(
      step.run.match(/See \[workflow logs\]\(\$\{RUN_URL\}\)\./g),
    ).toHaveLength(2);
    expect(inJobStep.run).toContain(
      `body="$(printf '%s\\n\\n%s' "$FALLBACK_MARKER" "$body")"`,
    );
    // ...and it must precede the post: moving the printf below the comment
    // keeps every existence assertion green yet ships in-job fallbacks
    // without the marker, breaking the dedup that keys on it.
    expect(
      inJobStep.run.indexOf(
        `body="$(printf '%s\\n\\n%s' "$FALLBACK_MARKER" "$body")"`,
      ),
    ).toBeLessThan(inJobStep.run.indexOf('gh pr comment'));
  });

  it('wires the needs result the cancelled-body branch keys on (issue #10109)', () => {
    // The step's bash runs under `set -u`, so dropping this env wiring
    // fails the step loudly instead of silently reverting every cancelled
    // run to the false "pipeline failed" body.
    expect(step.env.REVIEW_PR_RESULT).toBe('${{ needs.review-pr.result }}');
    expect(step.run).toContain(
      'if [ "$REVIEW_PR_RESULT" = "cancelled" ]; then',
    );
  });

  it('scopes the dedup to the authenticated bot login, resolved dynamically', () => {
    // upsert-bot-comment.sh protocol: only comments by the authenticated
    // login are dedup targets, or a participant posting the marker suppresses
    // the fallback. Resolving the login dynamically (as upsert does) locks
    // the filter to the account CI_BOT_PAT posts as.
    expect(step.run).toContain('bot_login="$(gh api user --jq \'.login\')"');
    expect(step.run).toContain('select(.author.login == \\"$bot_login\\")');
    // The agreement is load-bearing: the in-job comment must be posted by
    // the same account this lookup resolves via `gh api user`, or the
    // author-scoped filter never sees it and the fallback double-posts.
    expect(inJobStep.env.GH_TOKEN).toBe('${{ secrets.CI_BOT_PAT }}');
    expect(step.env.GH_TOKEN).toBe('${{ secrets.CI_BOT_PAT }}');
  });

  it('pins the run-URL shape the dedup anchors on', () => {
    // The dedup matches `actions/runs/<id>)` — anchored on the markdown
    // link's closing paren — so RUN_URL must END at the run id; a suffix
    // (an /attempts/N deep-link, plausibly) escapes the match and every
    // re-run of a dead review silently double-posts. Both steps must also
    // render the same shape, or the in-job comment's URL never matches the
    // fallback job's pattern.
    expect(step.env.RUN_URL).toMatch(
      /\/actions\/runs\/\$\{\{ github\.run_id \}\}$/,
    );
    expect(inJobStep.env.RUN_URL).toBe(step.env.RUN_URL);
  });

  it('opens the gate on any upstream failure but never on skip or resolve', () => {
    // Every job whose failure marks review-pr 'skipped' is enumerated: the
    // incident's trigger can kill the chain's self-hosted jobs first
    // (authorize / review-config), and a transient API failure can kill the
    // hosted ones (precheck-pr / delay-automatic-review).
    expect(job.needs).toEqual([
      'precheck-pr',
      'review-config',
      'authorize',
      'delay-automatic-review',
      'review-pr',
    ]);
    // Failure-keyed, not != 'success': resolve dispatch runs skip review-pr
    // BY DESIGN and would otherwise mint false-alarm fallbacks.
    expect(job.if).toContain("needs.review-pr.result == 'failure'");
    // A review-pr that dies to its own job-level timeout is auto-cancelled
    // (result 'cancelled', failure() false), which would open neither this
    // gate nor the in-job step — but `always()` keeps this job alive through
    // a RUN-level cancel, so a bare 'cancelled' clause posts a false "did
    // not complete" from a concurrency-superseded run while its same-head
    // twin is still reviewing (PR #9131, run 32558544379 — same head, so
    // the in-step head-moved guard cannot catch it). The two cancels differ
    // in `needs`: a timeout cancels review-pr ALONE, a run-level cancel
    // sweeps the upstream chain too. Pin the full compound clause — the
    // grouping included — so reverting either upstream conjunct fails here.
    expect(job.if).toContain(
      "(needs.review-pr.result == 'cancelled' &&\n" +
        "  needs.authorize.result != 'cancelled' &&\n" +
        "  needs.delay-automatic-review.result != 'cancelled') ||",
    );
    // ...and that clause must be the ONLY place the gate tests review-pr
    // for 'cancelled': a merge-conflict resolution keeping both sides
    // re-adds a bare `== 'cancelled'` disjunct beside the intact compound
    // clause — in any rendering (bare, parenthesized, respaced) — and the
    // gate opens on every cancelled review-pr again while the pin above
    // stays green. Counting occurrences catches every rendering.
    expect(
      job.if.match(/needs\.review-pr\.result == 'cancelled'/g),
    ).toHaveLength(1);
    expect(job.if).toContain("needs.authorize.result == 'failure'");
    expect(job.if).toContain("needs.review-config.result == 'failure'");
    expect(job.if).toContain(
      "needs.delay-automatic-review.result == 'failure'",
    );
    expect(job.if).toContain("needs.precheck-pr.result == 'failure'");
    expect(job.if).not.toContain("!= 'success'");
    expect(job.if).toContain("github.repository == 'QwenLM/qwen-code'");
    // On pull_request_target and issue_comment events review_mode is null,
    // so collapsing this disjunction would skip the job exactly where dead
    // review runs happen.
    expect(job.if).toContain("(github.event_name != 'workflow_dispatch' ||");
    expect(job.if).toContain("github.event.inputs.review_mode == 'comment'");
    // The job exists to survive whatever killed the review job; routing it
    // onto the self-hosted ECS pool would die the same death.
    expect(job['runs-on']).toBe('ubuntu-latest');
  });

  it('never opens the gate on a /resolve run, dispatch- or comment-driven', () => {
    // /resolve is a first-class issue_comment command too: authorize runs on
    // `@qwen-code /resolve` comments, and github.event.inputs is empty on
    // issue_comment, so the dispatch exclusion alone misdiagnoses a failed
    // resolve run as a dead review and recommends the wrong command.
    expect(job.if).toContain("github.event.inputs.command != 'resolve'");
    expect(job.if).toContain(
      "!(github.event_name == 'issue_comment' &&\n" +
        " startsWith(github.event.comment.body, '@qwen-code /resolve')) &&",
    );
  });

  it('probes the runner root three levels up and _diag when present', () => {
    const run = health.run;
    // The workspace sits at <runner-root>/_work/<owner>/<repo>; two levels
    // resolves to _work and never probes the directory whose _diag/pages
    // corruption killed the PR #8894 run.
    expect(run).toContain('GITHUB_WORKSPACE/../../..');
    expect(run).not.toMatch(/GITHUB_WORKSPACE\/\.\.\/\.\."/);
    expect(run).toContain('"$HOME"');
    expect(run).toContain('"${RUNNER_TEMP:?}"');
    expect(run).toContain('"$RUNNER_ROOT/_diag"');
    // Polarity: _diag is probed only when it EXISTS — an inverted guard
    // probes a nonexistent directory and fails fast on a healthy runner.
    expect(run).toContain('if [ -d "$RUNNER_ROOT/_diag" ]; then');
    expect(run).toContain('status=1');
    expect(run.trim()).toMatch(/exit "\$status"$/);
  });

  // The repair path names its canary with GNU `mktemp -u` (print-only):
  // BSD mktemp's `-u` still tries to create the file, so in the unwritable
  // directory the repair case breaks it exits nonzero with an empty name
  // and the post-repair touch can never succeed. The health probe only
  // runs on Linux runners (the review pool is Linux-only, same as the
  // realpath case above), so the defect cannot exist in production; probe
  // the host, not the platform — a BSD host with GNU coreutils fronting
  // PATH keeps the coverage.
  const hasGnuMktemp =
    spawnSync(
      'mktemp',
      ['-u', join(tmpdir(), 'qwen-no-such-dir', '.probe-XXXXXX')],
      { stdio: 'ignore' },
    ).status === 0;

  // Executed shape for the health probe: run the step's REAL bash against
  // a fake runner tree with a stub sudo, so the repair-vs-fail-fast
  // decision is exercised, not just textually pinned.
  function runHealthProbe({
    breakDir = '',
    sudoMode = 'repair',
    diag = true,
  } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'health-probe-'));
    const home = join(root, 'home');
    const temp = join(root, 'temp');
    const runnerRoot = join(root, 'runner');
    const workspace = join(runnerRoot, '_work', 'owner', 'repo');
    const broken = breakDir
      ? {
          home,
          temp,
          root: runnerRoot,
          diag: join(runnerRoot, '_diag'),
        }[breakDir]
      : '';
    try {
      mkdirSync(home);
      mkdirSync(temp);
      mkdirSync(workspace, { recursive: true });
      if (diag) mkdirSync(join(runnerRoot, '_diag'));
      if (broken) chmodSync(broken, 0o555);
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const sudo = join(bin, 'sudo');
      writeFileSync(
        sudo,
        [
          '#!/bin/bash',
          '[ "${SUDO_MODE:-repair}" = repair ] || exit 1',
          'for last in "$@"; do :; done',
          '[ "$2" = chmod ] && chmod u+rwx "$last"',
          'exit 0',
        ].join('\n') + '\n',
      );
      chmodSync(sudo, 0o755);
      let status = 0;
      let stdout = '';
      try {
        stdout = execFileSync('bash', ['-c', health.run], {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            SUDO_MODE: sudoMode,
            HOME: home,
            RUNNER_TEMP: temp,
            GITHUB_WORKSPACE: workspace,
          },
        });
      } catch (e) {
        status = e.status ?? 1;
        stdout = `${e.stdout ?? ''}`;
      }
      return { status, stdout };
    } finally {
      if (broken && existsSync(broken)) chmodSync(broken, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('passes a healthy runner without repair noise', () => {
    const r = runHealthProbe();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('::warning::');
    expect(r.stdout).not.toContain('repaired');
  });

  it.skipIf(!hasGnuMktemp)(
    'repairs a single unwritable directory instead of failing fast',
    () => {
      // Mutant control: a status=1 right after the first failed touch would
      // abort this repairable runner (exit 1) — a false fail-fast.
      const r = runHealthProbe({ breakDir: 'home' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('repaired write access');
    },
  );

  it('fails fast when repair is impossible', () => {
    // Mutant control: dropping the post-repair re-probe would report this
    // unusable directory as repaired (exit 0) and die at FinalizeJob — the
    // exact PR #8894 death the probe exists to prevent.
    const r = runHealthProbe({ breakDir: 'home', sudoMode: 'fail' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('still unusable after repair');
    expect(r.stdout).toContain('failing fast instead of dying at job finalize');
  });

  it('does not probe _diag when it does not exist', () => {
    // Polarity: an inverted `[ -d ]` guard probes the missing directory,
    // cannot create its probe file, and fails fast on a healthy runner.
    const r = runHealthProbe({ diag: false });
    expect(r.status).toBe(0);
  });

  // The stub answers the guard's reviews and run-view lookups by running the
  // caller's own `--jq` filter — that filter IS the thing under test — so
  // these cases need jq on PATH. Windows runners have none, and a stub that
  // silently produced nothing there would report the guard as broken rather
  // than untested. Probed once, skipped honestly.
  const hasJq = (() => {
    try {
      execFileSync('jq', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  // Executed shape: run the step's REAL bash with a stub gh that logs every
  // call. The stub pre-applies the dedup filter's semantics to the fixture
  // (the filter's author scope is pinned by the text test above).
  function runFallbackStep(
    scenario,
    {
      eventName = 'issue_comment',
      comments = '',
      runHead = '',
      prHead = '',
      useInJobStep = false,
      reviews = '[]',
      runCreated = '',
      runStartedAttempt = '',
      reviewPrResult = 'failure',
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'fallback-comment-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const calls = join(dir, 'calls');
      const summary = join(dir, 'summary');
      const posted = join(dir, 'posted');
      const commentsFile = join(dir, 'comments');
      writeFileSync(calls, '');
      writeFileSync(summary, '');
      writeFileSync(posted, '');
      writeFileSync(commentsFile, comments);
      const stub = (name, body) => {
        const p = join(bin, name);
        writeFileSync(p, body);
        chmodSync(p, 0o755);
      };
      stub('sleep', '#!/bin/bash\nexit 0\n');
      stub(
        'gh',
        [
          '#!/bin/bash',
          'echo "gh $*" >> "$CALLS"',
          'cmd="$1"; sub="${2:-}"',
          // Hoisted: both the run-view and the reviews branches run the
          // caller's own --jq, so the extraction cannot live inside one of them.
          'filter=""; prev=""',
          'for a in "$@"; do if [ "$prev" = "--jq" ]; then filter="$a"; fi; prev="$a"; done',
          'if [ "$cmd" = "api" ] && [ "$sub" = "user" ]; then',
          '  [ "${SCENARIO:-}" = "lookup_fail" ] && exit 1',
          '  echo "qwen-code-ci-bot"; exit 0',
          'fi',
          'if [ "$cmd" = "run" ] && [ "$sub" = "view" ]; then',
          '  case "$*" in',
          '    *createdAt*|*startedAt*)',
          '      [ "${SCENARIO:-}" = "runstart_fail" ] && exit 1',
          // Real --jq over an object carrying BOTH fields, exactly as the
          // reviews stub does: a `case` on "$*" answers a combined
          // `--json createdAt,startedAt --jq .startedAt` from whichever
          // substring branch comes first, so the discriminator between the
          // two anchors would silently stop discriminating.
          '      printf \'{"createdAt":"%s","startedAt":"%s"}\' "${RUN_CREATED:-}" "${RUN_STARTED_ATTEMPT:-}" | jq -r "$filter"; exit 0 ;;',
          '  esac',
          '  [ "${SCENARIO:-}" = "runview_fail" ] && exit 1',
          '  echo "${RUN_HEAD:-}"; exit 0',
          'fi',
          // The reviews lookup runs the step's REAL --jq filter over the
          // fixture: the guard under test IS that filter (author scope and
          // submission time — no head clause, which `attributes by TIME, not
          // by head` pins), so a stub that pre-applied it would pin nothing.
          'if [ "$cmd" = "api" ] && [ "${sub#repos/}" != "$sub" ]; then',
          '  [ "${SCENARIO:-}" = "reviews_fail" ] && exit 1',
          '  printf "%s" "$REVIEWS_JSON" | jq -r "$filter"; exit 0',
          'fi',
          'if [ "$cmd" = "pr" ] && [ "$sub" = "view" ]; then',
          '  case "$*" in',
          '    *comments*)',
          '      case "${SCENARIO:-}" in lookup_fail | comments_lookup_fail) exit 1 ;; esac',
          '      cat "$COMMENTS_FILE"; exit 0 ;;',
          '    *state,headRefOid*)',
          '      [ "${SCENARIO:-}" = "state_fail" ] && exit 1',
          '      state=OPEN; [ "${SCENARIO:-}" = "pr_closed" ] && state=MERGED',
          '      printf "%s\\t%s\\n" "$state" "${PR_HEAD:-}"; exit 0 ;;',
          // Live again: the fallback job reverted to a state-only query when
          // the guard stopped keying on the head, so this branch has a caller
          // once more (the in-job step keeps the combined shape above).
          '    *state*)',
          '      [ "${SCENARIO:-}" = "state_fail" ] && exit 1',
          '      [ "${SCENARIO:-}" = "pr_closed" ] && echo "MERGED" || echo "OPEN"; exit 0 ;;',
          '    *headRefOid*)',
          '      [ "${SCENARIO:-}" = "prview_fail" ] && exit 1',
          '      echo "${PR_HEAD:-}"; exit 0 ;;',
          '  esac',
          'fi',
          'if [ "$cmd" = "pr" ] && [ "$sub" = "comment" ]; then',
          '  prev=""; body=""',
          '  for a in "$@"; do [ "$prev" = "--body" ] && body="$a"; prev="$a"; done',
          '  printf \'%s\' "$body" > "$POSTED"',
          '  exit 0',
          'fi',
          'exit 1',
        ].join('\n') + '\n',
      );
      let status = 0;
      let stdout = '';
      try {
        stdout = execFileSync(
          'bash',
          [
            '-c',
            // The runner substitutes `${{ vars.* }}` before bash ever sees the
            // script; feeding the raw expression to bash is a `bad substitution`
            // that skips the assignment and leaves the variable unset — the
            // timeout body then compares against an empty string. Substituting
            // here is what makes "the step's real bash" true.
            (useInJobStep ? inJobStep.run : step.run).replace(
              /\$\{\{ vars\.QWEN_REVIEW_MAX_TIMEOUT_MINUTES \}\}/g,
              '180',
            ),
          ],
          {
            encoding: 'utf8',
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              SCENARIO: scenario,
              GITHUB_REPOSITORY: 'QwenLM/qwen-code',
              GITHUB_RUN_ID: '12345',
              GITHUB_EVENT_NAME: eventName,
              GITHUB_STEP_SUMMARY: summary,
              PR_NUMBER: '42',
              RUN_URL: 'https://github.com/QwenLM/qwen-code/actions/runs/12345',
              EXPECTED_HEAD_SHA: '',
              FAILURE_KIND: '',
              FAILURE_REASON:
                'Run review failed. See workflow logs for details.',
              TIMEOUT_MINUTES: '60',
              FALLBACK_MARKER: marker,
              RUN_HEAD: runHead,
              PR_HEAD: prHead,
              CALLS: calls,
              COMMENTS_FILE: commentsFile,
              POSTED: posted,
              REVIEWS_JSON: reviews,
              RUN_CREATED: runCreated,
              RUN_STARTED_ATTEMPT: runStartedAttempt,
              REVIEW_PR_RESULT: reviewPrResult,
            },
          },
        );
      } catch (e) {
        status = e.status ?? 1;
        stdout = `${e.stdout ?? ''}`;
      }
      return {
        status,
        stdout,
        calls: readFileSync(calls, 'utf8'),
        summary: readFileSync(summary, 'utf8'),
        posted: readFileSync(posted, 'utf8'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('posts the marker-headed retry comment when no fallback exists', () => {
    const r = runFallbackStep('default');
    expect(r.status).toBe(0);
    expect(r.posted.startsWith(`${marker}\n\n`)).toBe(true);
    expect(r.posted).toContain('actions/runs/12345');
  });

  it('posts the cancellation body, not the failure one, for a cancelled review-pr', () => {
    // Issue #10109: a cancelled review-pr reaches the gate two ways — its
    // own job-level timeout, and a run/job cancel landing after the
    // upstream chain finished (run 32875478404) — and for neither is
    // "pipeline failed / retried automatically" true. Silence would regress
    // the timeout flavor, so the cancelled case gets its own body.
    const cancelled = runFallbackStep('default', {
      reviewPrResult: 'cancelled',
    });
    expect(cancelled.status).toBe(0);
    expect(cancelled.posted.startsWith(`${marker}\n\n`)).toBe(true);
    expect(cancelled.posted).toContain('cancelled');
    // The claims the issue calls out must not ride a cancellation...
    expect(cancelled.posted).not.toContain('did not complete successfully');
    expect(cancelled.posted).not.toContain('The review pipeline failed');
    expect(cancelled.posted).not.toContain(
      'A transient error is retried automatically',
    );
    // ...while the `)`-anchored run URL the cross-job dedup matches and the
    // retry instruction (the job-timeout flavor's reader needs it) stay.
    expect(cancelled.posted).toContain('actions/runs/12345)');
    expect(cancelled.posted).toContain('@qwen-code /review');
    // The failure path keeps the original body.
    const failed = runFallbackStep('default', { reviewPrResult: 'failure' });
    expect(failed.posted).toContain('did not complete successfully');
  });

  it('dedupes on the marker plus this run URL', () => {
    // Mirrors a prior fallback comment's rendered shape: the run URL is a
    // markdown link, so the run id is always immediately followed by ')'.
    const r = runFallbackStep('already', {
      comments: `${marker}\n\nSee [workflow logs](https://github.com/QwenLM/qwen-code/actions/runs/12345).`,
    });
    expect(r.status).toBe(0);
    expect(r.posted).toBe('');
    expect(r.summary).toContain('already exists');
  });

  it("still posts when only another run's fallback exists", () => {
    // Run ids grow digits over time, so a later run's id (123450) contains
    // this run's (12345) as a substring — the match must stay anchored to
    // this run's URL or a distinct run's death is silently suppressed.
    const r = runFallbackStep('other_run', {
      comments: `${marker}\n\nSee [workflow logs](https://github.com/QwenLM/qwen-code/actions/runs/123450).`,
    });
    expect(r.status).toBe(0);
    expect(r.posted).not.toBe('');
  });

  it('fails closed when the dedup lookup keeps failing', () => {
    // A failed listing must never be treated as an empty result — posting
    // on it is how a transient 5xx mints a permanent duplicate.
    const r = runFallbackStep('lookup_fail');
    expect(r.status).toBe(1);
    expect(r.posted).toBe('');
    expect(r.stdout).toContain('::error::');
    expect((r.calls.match(/^gh api user --jq/gm) ?? []).length).toBe(3);
  });

  it('fails closed when only the comments listing keeps failing', () => {
    // gh api user succeeds here, so only the loop's post-failure resets
    // keep bot_login empty; deleting them posts on a failed listing — the
    // permanent duplicate the step's comment forbids.
    const r = runFallbackStep('comments_lookup_fail');
    expect(r.status).toBe(1);
    expect(r.posted).toBe('');
    expect(r.stdout).toContain('::error::');
  });

  it('fails closed when the PR state check itself fails', () => {
    const r = runFallbackStep('state_fail');
    expect(r.status).toBe(1);
    expect(r.posted).toBe('');
    expect(r.stdout).toContain('::error::');
  });

  it('skips a non-OPEN PR with exit 0', () => {
    const r = runFallbackStep('pr_closed');
    expect(r.status).toBe(0);
    expect(r.posted).toBe('');
    expect(r.summary).toContain('MERGED');
  });

  it('skips a stale run whose head moved on pull_request_target', () => {
    const r = runFallbackStep('moved', {
      eventName: 'pull_request_target',
      runHead: 'oldsha',
      prHead: 'newsha',
    });
    expect(r.status).toBe(0);
    expect(r.posted).toBe('');
    // The skip happens before the dedup lookup is even attempted.
    expect(r.calls).not.toContain('--json comments');
  });

  it('still posts on comment/review runs where the head is not comparable', () => {
    // Comment and review runs report main's tip as headSha, so a naive
    // comparison would suppress the fallback on the very path the job
    // exists for; posting wins over silence there.
    const r = runFallbackStep('moved_comment', {
      eventName: 'issue_comment',
      runHead: 'oldsha',
      prHead: 'newsha',
    });
    expect(r.status).toBe(0);
    expect(r.posted).not.toBe('');
    // Pinned on the head lookup itself, not on `gh run view` as a whole:
    // the already-posted guard below asks the same command for this run's
    // createdAt on every event, and a blanket "no run view" assertion would
    // read that as a head comparison it never makes.
    expect(r.calls).not.toContain('headSha');
    expect(r.calls).not.toContain('--json headRefOid');
  });

  it('degrades to POSTING when the head comparison lookups fail', () => {
    const r = runFallbackStep('runview_fail', {
      eventName: 'pull_request_target',
    });
    expect(r.status).toBe(0);
    expect(r.posted).not.toBe('');
  });

  it('still posts on pull_request_target when only the run-head lookup fails', () => {
    // A transient gh-run-view failure while gh-pr-view succeeds must not
    // suppress the fallback: comparison unavailable means posting wins.
    const r = runFallbackStep('runview_fail', {
      eventName: 'pull_request_target',
      prHead: 'newsha',
    });
    expect(r.status).toBe(0);
    expect(r.posted).not.toBe('');
  });

  it('still posts on pull_request_target when only the PR-head lookup fails', () => {
    const r = runFallbackStep('prview_fail', {
      eventName: 'pull_request_target',
      runHead: 'oldsha',
    });
    expect(r.status).toBe(0);
    expect(r.posted).not.toBe('');
  });

  // A run can fail AFTER posting its review — the CLI exiting silently, a
  // cleanup step dying — and both fallback bodies then announce a review
  // sitting right above them as one that could not be posted, retry
  // instruction attached. Measured on PR #9342: review posted 11:56:34Z,
  // review-pr failed 12:00:53Z, the comment landed 12:01:00Z asking for a
  // fresh ~3-hour review; the autofix takeover loop reads the same feed a
  // human does. The guard is a FILTER (author scope and submission
  // time), so these run the step's real bash over review fixtures.
  // The run was CREATED at 09:08:38Z; a re-run of its failed job later moved
  // run-level startedAt to 11:30:00Z. Attempt 1's review sits between them —
  // the shape that separates the two anchors.
  const RUN_CREATED = '2026-08-18T09:08:38Z';
  const RUN_RESTARTED = '2026-08-18T11:30:00Z';
  const AFTER = '2026-08-18T11:56:34Z';
  const MID_RERUN = '2026-08-18T10:00:00Z';
  const BEFORE = '2026-08-17T10:00:00Z';
  const reviewFixture = (login, commit, submitted, body = null) =>
    JSON.stringify([
      {
        id: 1,
        user: { login },
        commit_id: commit,
        submitted_at: submitted,
        body,
      },
    ]);

  // The bot account posts more than this pipeline's reviews:
  // finalize-release.yml approves release PRs under the same CI_BOT_PAT,
  // qwen-triage-finalize.yml posts a deferred APPROVE under
  // QWEN_CODE_BOT_TOKEN || CI_BOT_PAT, and the triage skill posts its own
  // commit-pinned APPROVE through the reviews API. In-window approvals like
  // these must not buy the silence that only THIS pipeline's own review
  // earns.
  const FOREIGN_APPROVAL_BODIES = [
    'Automated second approval for the release version bump.',
    'LGTM, looks ready to ship — CI landed green after the review. ✅',
    'LGTM, looks ready to ship. ✅',
  ];

  // What the guard recognizes a review THIS pipeline composed by: every
  // composed body carries the "via Qwen Code /review" attribution footer or
  // the invisible qwen-review-ledger marker — at least one, never neither —
  // and no foreign approval carries either. Matching on that evidence is how
  // the guard stays closed to a producer set no exclusion list can finish.
  const REVIEW_FOOTER = '_— qwen3.8-max via Qwen Code /review (v0.21.14)_';
  const REVIEW_LEDGER = '<!-- qwen-review-ledger {"v":1,"round":2} -->';
  const COMPOSED_REVIEW_BODIES = [
    // Attribution on: the footer and the ledger marker both ride the body.
    `No issues found. LGTM! ✅\n\n${REVIEW_FOOTER}\n\n${REVIEW_LEDGER}`,
    // Attribution off: no footer, but the ledger marker still rides.
    `No issues found. LGTM! ✅\n\n${REVIEW_LEDGER}`,
    // Pre-ledger bundles posted the footer alone.
    `No issues found. LGTM! ✅\n\n${REVIEW_FOOTER}`,
  ];

  for (const useInJobStep of [false, true]) {
    const site = useInJobStep ? 'in-job step' : 'fallback job';

    it.skipIf(!hasJq)(
      `${site} stays silent when THIS run already posted its review`,
      () => {
        // Every shape compose-review can post must buy the silence: the
        // guard attributes by the markers a composed body carries, so each
        // marker alone — and both together — has to match.
        for (const body of COMPOSED_REVIEW_BODIES) {
          const r = runFallbackStep('default', {
            useInJobStep,
            prHead: 'HEADSHA1',
            runCreated: RUN_CREATED,
            runStartedAttempt: RUN_RESTARTED,
            reviews: reviewFixture('qwen-code-ci-bot', 'HEADSHA1', AFTER, body),
          });
          expect(r.status, body).toBe(0);
          expect(r.posted, body).toBe('');
          expect(r.summary, body).toContain(
            'a bot review of this PR was submitted',
          );
        }
      },
    );

    it.skipIf(!hasJq)(
      `${site} still posts when no review can be attributed to this run`,
      () => {
        // Each clause alone must keep the fallback speaking, or a stale or
        // foreign review buys silence on a genuinely dead pipeline: an earlier
        // run's review (outside the window), another account's, an unsubmitted
        // (PENDING) one, and none at all. The head is deliberately not a clause
        // — see the attribute-by-TIME test below.
        const cases = {
          stale: reviewFixture(
            'qwen-code-ci-bot',
            'HEADSHA1',
            BEFORE,
            COMPOSED_REVIEW_BODIES[0],
          ),
          foreign: reviewFixture(
            'someone-else',
            'HEADSHA1',
            AFTER,
            COMPOSED_REVIEW_BODIES[0],
          ),
          pending: reviewFixture(
            'qwen-code-ci-bot',
            'HEADSHA1',
            null,
            COMPOSED_REVIEW_BODIES[0],
          ),
          none: '[]',
        };
        for (const [name, reviews] of Object.entries(cases)) {
          const r = runFallbackStep('default', {
            useInJobStep,
            prHead: 'HEADSHA1',
            runCreated: RUN_CREATED,
            runStartedAttempt: RUN_RESTARTED,
            reviews,
          });
          expect(r.posted, name).not.toBe('');
        }
      },
    );

    it.skipIf(!hasJq)(
      `${site} still posts when the only in-window reviews are foreign approvals`,
      () => {
        // The guard's author + window clauses match ANY review the account
        // posts, and the account also approves release PRs (finalize-release
        // .yml), posts deferred triage approvals (qwen-triage-finalize.yml),
        // and approves through the triage skill's reviews-API call. None of
        // these bodies carries a composed-review marker, so none may silence
        // the fallback while THIS pipeline's review is absent — the LGTM
        // would mask a dead run.
        for (const body of FOREIGN_APPROVAL_BODIES) {
          const r = runFallbackStep('default', {
            useInJobStep,
            prHead: 'HEADSHA1',
            runCreated: RUN_CREATED,
            runStartedAttempt: RUN_RESTARTED,
            reviews: reviewFixture('qwen-code-ci-bot', 'HEADSHA1', AFTER, body),
          });
          expect(r.posted, body).not.toBe('');
        }
      },
    );

    it.skipIf(!hasJq)(
      `${site} survives a job re-run: attempt 1's review still silences it`,
      () => {
        // Re-running a failed job keeps the run id but moves run-level
        // startedAt to the re-executed attempt (measured: runs 32219268680 and
        // 32218596441 report startedAt ~28 and ~9 minutes after createdAt).
        // Anchored there, attempt 1's review reads as older than "this run",
        // and a re-run that fails before posting contradicts it — the very
        // shape this guard exists to stop. The stub answers createdAt and
        // startedAt with DIFFERENT values, so this fails if the guard reads
        // the wrong field.
        const r = runFallbackStep('default', {
          useInJobStep,
          prHead: 'HEADSHA1',
          runCreated: RUN_CREATED,
          runStartedAttempt: RUN_RESTARTED,
          reviews: reviewFixture(
            'qwen-code-ci-bot',
            'HEADSHA1',
            MID_RERUN,
            COMPOSED_REVIEW_BODIES[0],
          ),
        });
        expect(r.status).toBe(0);
        expect(r.posted).toBe('');
        expect(r.summary).toContain('a bot review of this PR was submitted');
      },
    );

    it.skipIf(!hasJq)(
      `${site} says so in the log when the guard cannot run`,
      () => {
        // A lookup that DIED degrades to the false comment this change
        // removes, and silence there leaves an oncall unable to tell it from
        // "no review matched". Both unavailable paths announce themselves.
        for (const scenario of ['runstart_fail', 'reviews_fail']) {
          const r = runFallbackStep(scenario, {
            useInJobStep,
            prHead: 'HEADSHA1',
            runCreated: RUN_CREATED,
            runStartedAttempt: RUN_RESTARTED,
            reviews: reviewFixture('qwen-code-ci-bot', 'HEADSHA1', AFTER),
          });
          expect(r.posted, scenario).not.toBe('');
          expect(r.stdout, scenario).toContain(
            '::warning::already-posted guard',
          );
          expect(r.summary, scenario).toContain(
            'Already-posted guard unavailable',
          );
        }
      },
    );

    it.skipIf(!hasJq)(
      `${site} posts when this run's creation time is unavailable`,
      () => {
        // Without a start time there is no proof the review landed during THIS
        // run, and posting wins over silence — the same call the head-moved
        // guard makes when its comparison is unavailable.
        const r = runFallbackStep('runstart_fail', {
          useInJobStep,
          prHead: 'HEADSHA1',
          runCreated: RUN_CREATED,
          runStartedAttempt: RUN_RESTARTED,
          reviews: reviewFixture('qwen-code-ci-bot', 'HEADSHA1', AFTER),
        });
        expect(r.posted).not.toBe('');
      },
    );

    it.skipIf(!hasJq)(
      `${site} posts when the reviews lookup itself fails`,
      () => {
        // Same direction as every other lookup this step makes for a SKIP
        // decision: a failed listing is never read as "a review exists".
        const r = runFallbackStep('reviews_fail', {
          useInJobStep,
          prHead: 'HEADSHA1',
          runCreated: RUN_CREATED,
          runStartedAttempt: RUN_RESTARTED,
          reviews: reviewFixture('qwen-code-ci-bot', 'HEADSHA1', AFTER),
        });
        expect(r.posted).not.toBe('');
      },
    );
  }

  it.skipIf(!hasJq)(
    "attributes by TIME, not by head — a moved head cannot hide this run's review",
    () => {
      // The head is not a stable attribute of a run: a push moves the PR's head
      // between the post and this step, and a re-run recomputes the reviewed
      // head from a later attempt. Two revisions of this guard keyed on it and
      // both re-opened the #9342 contradiction through one of those doors. What
      // the guard proves now is narrower and stable — a bot review of this PR
      // submitted while this run was alive — so a review on ANY head inside the
      // window silences the comment.
      for (const useInJobStep of [false, true]) {
        const r = runFallbackStep('default', {
          useInJobStep,
          prHead: 'NEWSHA',
          runCreated: RUN_CREATED,
          runStartedAttempt: RUN_RESTARTED,
          reviews: reviewFixture(
            'qwen-code-ci-bot',
            'OLDSHA',
            AFTER,
            COMPOSED_REVIEW_BODIES[0],
          ),
        });
        expect(r.status, String(useInJobStep)).toBe(0);
        expect(r.posted, String(useInJobStep)).toBe('');
        expect(r.summary, String(useInJobStep)).toContain(
          'a bot review of this PR was submitted after this run was created',
        );
      }
    },
  );

  it('carries no cross-job head wiring to drift', () => {
    // An earlier revision published review-pr's reviewed head as a job output
    // and read it here. The guard no longer keys on the head at all, so the
    // wiring is gone rather than left as an untested chain whose silent
    // breakage would restore the fresh-head comparison.
    expect(doc.jobs['review-pr'].outputs).toBeUndefined();
    expect(step.env.REVIEWED_HEAD_SHA).toBeUndefined();
    expect(step.run).not.toContain('REVIEWED_HEAD_SHA');
    expect(inJobStep.run).not.toContain('commit_id ==');
    expect(step.run).not.toContain('commit_id ==');
  });

  it('in-job step dedupes on a fallback comment this run already has', () => {
    // Re-runs of failed jobs keep the run id: when a prior attempt died
    // before its in-job step, the fallback-comment job already posted for
    // this run, so the in-job step must not add a second comment.
    const r = runFallbackStep('already', {
      useInJobStep: true,
      comments: `${marker}\n\nSee [workflow logs](https://github.com/QwenLM/qwen-code/actions/runs/12345).`,
    });
    expect(r.status).toBe(0);
    expect(r.posted).toBe('');
    expect(r.summary).toContain('already exists');
  });

  it('in-job step still posts when no fallback comment exists', () => {
    const r = runFallbackStep('default', { useInJobStep: true });
    expect(r.status).toBe(0);
    expect(r.posted.startsWith(`${marker}\n\n`)).toBe(true);
    expect(r.posted).toContain('actions/runs/12345');
  });

  it('in-job step defers to the fallback job when its dedup lookup fails', () => {
    const r = runFallbackStep('lookup_fail', { useInJobStep: true });
    expect(r.status).toBe(0);
    expect(r.posted).toBe('');
    expect(r.summary).toContain('deferring to the fallback-comment job');
  });
});

describe('review supersede salvage (#10110)', () => {
  // cancel-in-progress no longer fires on synchronize (that pin lives in the
  // resolve suite next to the wrapper-guard replays); the supersede decision
  // moved into the in-flight run. These tests pin the three moving parts:
  // the watcher that decides KEEP vs CEDE, the retry loop's early exits, and
  // the posting path for a salvaged run.
  const doc = parse(workflow);
  const run = runReviewStep();

  it('arms the watcher only for automatic lifecycle reviews', () => {
    // Explicit runs (/review, review_requested, dispatch) were never
    // synchronize-cancellable; killing a review a human just asked for over
    // a push would be a regression, so the watcher must stay AUTO-gated.
    expect(run).toContain('supersede_watcher()');
    expect(run).toContain(
      'if [ "${AUTO_REVIEW:-false}" = "true" ]; then\n  supersede_watcher &',
    );
    // Defined and armed before the retry loop starts.
    expect(run.indexOf('supersede_watcher()')).toBeLessThan(
      run.indexOf('attempt=1'),
    );
  });

  it('never arms the watcher in a replay even if the environment exports AUTO_REVIEW', () => {
    // runScenario spreads the parent environment and the extraction window
    // contains the arming: without the false pin, an inherited
    // AUTO_REVIEW=true arms a watcher with no REPO for its gh poll,
    // spinning against the instant-exit sleep stub and holding the stdout
    // pipe open — the replay dies on runScenario's 30s bound instead of
    // finishing. The pin must outrank extraEnv too, so inject explicitly.
    const r = runScenario('success', { extraEnv: { AUTO_REVIEW: 'true' } });
    expect(r.timedOut).toBe(false);
    expect(r.line).toBe('OK outcome=success');
  });

  it('checks supersede and salvage-cede before classifying the attempt outcome', () => {
    // A watcher kill surfaces as a non-zero qwen status; classified first it
    // would read as fatal (job red, fallback machinery engaged) or retryable
    // (a from-scratch re-review of a superseded head). The supersede check
    // also runs at the TOP of the loop: a cede landing during the retry
    // backoff (pkill matched nothing — qwen not running) must stop the next
    // attempt before it re-reviews the dead head.
    const check = 'if [ -f "${SUPERSEDE_FILE:-}" ] && live_head_moved; then';
    const guardedCheck =
      'if [ "$OUTCOME" != "success" ] && [ -f "${SUPERSEDE_FILE:-}" ] && live_head_moved; then';
    const call = run.indexOf('run_review_once "$attempt_timeout" "$PROMPT"');
    const preAttempt = run.indexOf(check);
    const supersede = run.indexOf(guardedCheck, call);
    const cede = run.indexOf(
      'if [ "${AUTO_REVIEW:-false}" = "true" ] && [ "$OUTCOME" != "success" ] && [ -f "${QWEN_CI_REVIEW_SALVAGE_OK_FILE:-}" ] && live_head_moved; then',
    );
    const success = run.indexOf('if [ "$OUTCOME" = "success" ]; then');
    expect(call).toBeGreaterThan(-1);
    expect(preAttempt).toBeGreaterThan(-1);
    expect(preAttempt).toBeLessThan(call);
    expect(supersede).toBeGreaterThan(call);
    expect(cede).toBeGreaterThan(supersede);
    expect(success).toBeGreaterThan(cede);
  });

  it('shares one cede implementation across both supersede sites', () => {
    // The halve-budget-floor incident: two verbatim copies diverged through
    // a one-sided edit. Pin the pair structurally — one definition, two
    // call sites — so a one-sided signal edit cannot survive the replays.
    expect((run.match(/cede_superseded\(\) \{/g) ?? []).length).toBe(1);
    expect((run.match(/cede_superseded/g) ?? []).length).toBe(5);
  });

  it('decides KEEP vs CEDE with the extracted salvage_eligible', () => {
    const fn = run.match(/salvage_eligible\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    const eligible = (elapsed, budget, composeSeen, pct) => {
      try {
        execFileSync(
          'bash',
          [
            '-c',
            `set -euo pipefail\n${fn}\nsalvage_eligible ${elapsed} ${budget} ${composeSeen} ${pct}`,
          ],
          { encoding: 'utf8' },
        );
        return true;
      } catch {
        return false;
      }
    };
    // Compose done → always keep, however early.
    expect(eligible(60, 21600, 'true', 50)).toBe(true);
    // The motivating incident: PR #9729's 4h06m (14760s) review on a
    // 360-minute (21600s) budget crosses the default 50% threshold.
    expect(eligible(14760, 21600, 'false', 50)).toBe(true);
    // Exactly at the threshold keeps; just below cedes.
    expect(eligible(10800, 21600, 'false', 50)).toBe(true);
    expect(eligible(10799, 21600, 'false', 50)).toBe(false);
    // pct=100 keeps only a run that spent its whole budget (in practice:
    // compose-signal only); pct=0 keeps always.
    expect(eligible(21599, 21600, 'false', 100)).toBe(false);
    expect(eligible(1, 21600, 'false', 0)).toBe(true);
  });

  // Extract the watcher itself and drive it to its one-shot decision with
  // stub gh/pkill/sleep — wiring the salvage_eligible result to the two
  // signal writes the rest of the system consumes (the marker and the
  // supersede file). String pins alone let a flipped dispatch or a
  // wrong-head marker ship green.
  function watcherSource() {
    return run.match(/supersede_watcher\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  }

  function writeSignalSource() {
    return run.match(/write_signal\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  }

  function runWatcher({
    liveHead = 'head-b',
    expectedHead = 'head-a',
    budget = 21600,
    runElapsed = 60,
    attemptElapsed = runElapsed,
    composeSeen = false,
    composedArtifact = null,
    docsOnly = false,
    pct = 50,
    plant = {},
    failFirstPoll = false,
    emptyFirstPoll = false,
    attemptStartRaw = null,
    removeSalvageDir = false,
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'review-watcher-'));
    // Stubs and logs live OUTSIDE SALVAGE_DIR: the delete variant removes it
    // wholesale before the watcher runs.
    const side = mkdtempSync(join(tmpdir(), 'review-watcher-side-'));
    try {
      const now = Math.floor(Date.now() / 1000);
      writeFileSync(
        join(dir, 'attempt-start'),
        attemptStartRaw ?? String(now - attemptElapsed),
      );
      if (composeSeen) {
        writeFileSync(join(dir, 'compose-seen'), '');
      }
      if (composedArtifact !== null) {
        writeFileSync(join(dir, 'composed.json'), composedArtifact);
      }
      // Attacker-planted FIFOs at the derivable signal names: every
      // write-open or ungated read-open of one blocks, so a regression
      // dies on the execFileSync timeout below instead of deciding.
      for (const name of Object.keys(plant)) {
        rmSync(join(dir, name), { force: true });
        execFileSync('mkfifo', [join(dir, name)]);
      }
      const bin = join(side, 'bin');
      mkdirSync(bin);
      const pkillLog = join(side, 'pkills');
      // The deletion dual of the planted-signal findings: SALVAGE_DIR is
      // agent-derivable and can vanish mid-run; the watcher must still
      // decide (its writes are best-effort) instead of dying on a failed
      // mktemp under the inherited errexit.
      if (removeSalvageDir) {
        rmSync(dir, { recursive: true, force: true });
      }
      const write = (name, body) => {
        const p = join(bin, name);
        writeFileSync(p, body);
        chmodSync(p, 0o755);
      };
      write('sleep', '#!/bin/bash\nexit 0\n');
      write(
        'gh',
        failFirstPoll || emptyFirstPoll
          ? [
              '#!/bin/bash',
              `count_file="${side}/gh-count"`,
              'n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))',
              'echo "$n" > "$count_file"',
              'if [ "$n" -eq 1 ]; then',
              failFirstPoll ? '  exit 1' : '  exit 0',
              'fi',
              `echo "${liveHead}"`,
            ].join('\n') + '\n'
          : `#!/bin/bash\necho "${liveHead}"\n`,
      );
      write('pkill', `#!/bin/bash\necho "$*" >> "${pkillLog}"\n`);
      const eligible =
        run.match(/salvage_eligible\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
      const harness = [
        'set -euo pipefail',
        eligible,
        writeSignalSource(),
        watcherSource(),
        `START_TS=${now - runElapsed}; BUDGET_SECONDS=${budget}; SALVAGE_ELAPSED_PERCENT=${pct}`,
        `EXPECTED_HEAD_SHA=${expectedHead}; DOCS_ONLY_MEDIUM=${docsOnly ? 'true' : 'false'}`,
        'PR_NUMBER=1; REPO=o/r; REVIEW_URL=https://example.test/pr/1; SALVAGE_POLL_SECONDS=0',
        `SALVAGE_DIR="${dir}"; SUPERSEDE_FILE="${dir}/superseded"`,
        `QWEN_CI_REVIEW_SALVAGE_OK_FILE="${dir}/salvage-ok"; COMPOSED_ARTIFACT="${dir}/composed.json"`,
        'supersede_watcher',
      ].join('\n');
      try {
        execFileSync('bash', ['-c', harness], {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
      } catch {
        // A watcher that dies before its one-shot decision (errexit on a
        // failed poll, a wedged read) leaves absent signals — read what
        // is there and let the assertions name the gap.
      }
      const readOr = (name) =>
        existsSync(join(dir, name))
          ? readFileSync(join(dir, name), 'utf8')
          : null;
      return {
        marker: readOr('salvage-ok'),
        movedTo: readOr('moved-to'),
        superseded: readOr('superseded'),
        pkilled: existsSync(pkillLog),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(side, { recursive: true, force: true });
    }
  }

  it('wires the watcher decision to the marker and supersede file (replayed watcher)', () => {
    // Below threshold: CEDE — the supersede file carries the LIVE head, no
    // marker is armed, and the qwen tree is killed.
    const cede = runWatcher({});
    expect(cede.superseded).toBe('head-b');
    expect(cede.marker).toBeNull();
    expect(cede.pkilled).toBe(true);

    // Past threshold: KEEP — the marker carries the REVIEWED head (the
    // wrapper guard compares it against the expected head), not the live
    // one; moved-to records where the PR went; nothing is killed.
    const keep = runWatcher({ runElapsed: 12000, attemptElapsed: 12000 });
    expect(keep.marker).toBe('head-a');
    expect(keep.movedTo).toBe('head-b');
    expect(keep.superseded).toBeNull();
    expect(keep.pkilled).toBe(false);

    // Compose seen: KEEP however early — posting is minutes out.
    const composed = runWatcher({ composeSeen: true });
    expect(composed.marker).toBe('head-a');
    expect(composed.superseded).toBeNull();
  });

  it('cedes a moved head on a fresh retry attempt (replayed watcher)', () => {
    // Attempt 1 burned 12000s of the 21600s budget (past 50%) and died
    // retryable; attempt 2 is seconds old when the head moves. Run-level
    // elapsed would KEEP — exactly the state the threshold policy says to
    // CEDE; attempt-relative elapsed cedes.
    const r = runWatcher({ runElapsed: 12000, attemptElapsed: 30 });
    expect(r.superseded).toBe('head-b');
    expect(r.marker).toBeNull();
  });

  it('never arms salvage for a docs-only run (replayed watcher)', () => {
    // The medium relay skips any moved head and the salvage-note step
    // excludes docs-only, so an armed KEEP could never post: cede even
    // past the threshold.
    const r = runWatcher({
      runElapsed: 12000,
      attemptElapsed: 12000,
      docsOnly: true,
    });
    expect(r.superseded).toBe('head-b');
    expect(r.marker).toBeNull();
  });

  it('never blocks a signal write or read on a planted FIFO (replayed watcher)', () => {
    // Every signal name is agent-derivable (SALVAGE_DIR derives from the
    // exported marker path), so the reviewed agent can mkfifo one and
    // block a direct open: write-side the CEDE/KEEP decision, read-side
    // the attempt-start poll. Writes go aside-then-rename and the read
    // gates on [ -f ], so all three plants still reach the one-shot
    // decision inside the bounded timeout — a direct `>` or an ungated
    // cat hangs and this test dies on the timeout instead.
    const cede = runWatcher({ plant: { superseded: 'fifo' } });
    expect(cede.superseded).toBe('head-b');
    expect(cede.pkilled).toBe(true);
    const keep = runWatcher({
      runElapsed: 12000,
      attemptElapsed: 12000,
      plant: { 'moved-to': 'fifo' },
    });
    expect(keep.marker).toBe('head-a');
    expect(keep.superseded).toBeNull();
    const fresh = runWatcher({ plant: { 'attempt-start': 'fifo' } });
    expect(fresh.superseded).toBe('head-b');
    // The latch write itself: a compose-seen FIFO plus a real artifact
    // must still latch (KEEP) — the write renames over the plant.
    const latch = runWatcher({
      composedArtifact: '{"downgraded":false}',
      attemptElapsed: 30,
      plant: { 'compose-seen': 'fifo' },
    });
    expect(latch.marker).toBe('head-a');
    expect(latch.superseded).toBeNull();
  });

  it('latches the compose signal only from a real composed artifact (replayed watcher)', () => {
    // A genuinely composed verdict below the elapsed threshold: KEEP —
    // posting is minutes out, and discarding it is the #9729 shape. This is
    // the only case exercising artifact -> latch -> KEEP end-to-end.
    const valid = runWatcher({
      composedArtifact: '{"downgraded":false,"downgradedFrom":null}',
      attemptElapsed: 30,
    });
    expect(valid.marker).toBe('head-a');
    expect(valid.superseded).toBeNull();
    // The path is agent-derivable, so the latch must refuse forged
    // artifacts: below the threshold the watcher still cedes.
    for (const forged of ['', '{not json', 'null', '[1,2]']) {
      const r = runWatcher({ composedArtifact: forged, attemptElapsed: 30 });
      expect(r.marker, JSON.stringify(forged)).toBeNull();
      expect(r.superseded, JSON.stringify(forged)).toBe('head-b');
    }
    // A FIFO at the artifact path must not wedge the poll — [ -f ] refuses
    // it and the watcher still cedes (bounded by the harness timeout).
    const fifo = runWatcher({
      composedArtifact: '{"downgraded":false}',
      attemptElapsed: 30,
      plant: { 'composed.json': 'fifo' },
    });
    expect(fifo.marker).toBeNull();
    expect(fifo.superseded).toBe('head-b');
  });

  it('still decides when SALVAGE_DIR vanished before the head move (replayed watcher)', () => {
    // The deletion dual of the planted-FIFO hardening: SALVAGE_DIR is
    // agent-derivable and can be rm -rf'd (or chmod'd, or ENOSPC) mid-run.
    // Under the inherited errexit an unguarded write_signal would kill the
    // watcher before its pkill — the attempt then reviews the dead head
    // for the whole budget. Best-effort writes must degrade to the
    // live-head re-check: the tree is still killed and the cede taken,
    // even with the signals unwritable.
    const r = runWatcher({ removeSalvageDir: true });
    expect(r.pkilled).toBe(true);
    expect(r.superseded).toBeNull();
    expect(r.marker).toBeNull();
    expect(r.movedTo).toBeNull();
  });

  it('rejects a leading-zero attempt-start instead of dying on octal arithmetic (replayed watcher)', () => {
    // attempt-start is agent-writable; `08` passes a digits-only guard but
    // aborts the poll's $(()) with 'value too great for base' — a silent
    // watcher death no relaunch ever fixes. The guard must fall back to
    // the run start and still act on the moved head.
    const r = runWatcher({ attemptStartRaw: '08' });
    expect(r.superseded).toBe('head-b');
    expect(r.pkilled).toBe(true);
    expect(r.marker).toBeNull();
  });

  it('keeps a late retry attempt salvage-eligible against its own budget (replayed watcher)', () => {
    // Attempt 1 spent 12000s of the 21600s budget and died retryable;
    // attempt 2 owns the 9600s that were left. When its head moves after
    // 8000s — 83% of the only budget it ever had — the run must KEEP and
    // post: the run-level denominator made the elapsed KEEP branch
    // structurally unreachable (8000/21600 < 50%) and CEDE-killed the
    // attempt minutes from posting.
    const late = runWatcher({ runElapsed: 20000, attemptElapsed: 8000 });
    expect(late.marker).toBe('head-a');
    expect(late.movedTo).toBe('head-b');
    expect(late.superseded).toBeNull();
    // Control: a fresh attempt at the same run depth still cedes early.
    const fresh = runWatcher({ runElapsed: 20000, attemptElapsed: 30 });
    expect(fresh.marker).toBeNull();
    expect(fresh.superseded).toBe('head-b');
  });

  it('keeps polling past failed or empty gh reads (replayed watcher)', () => {
    // One transient gh failure among hundreds of polls is routine; under
    // the step's errexit only `|| continue` keeps it from silently
    // killing the watcher subshell. The failed poll must be skipped and
    // the next one still reach the one-shot decision.
    const failed = runWatcher({ failFirstPoll: true });
    expect(failed.superseded).toBe('head-b');
    expect(failed.pkilled).toBe(true);
    expect(failed.marker).toBeNull();
    // An empty read (exit 0, no head) must not decide either — the
    // [ -z ] conjunct skips it like an unmoved head.
    const empty = runWatcher({ emptyFirstPoll: true });
    expect(empty.superseded).toBe('head-b');
    expect(empty.pkilled).toBe(true);
    expect(empty.marker).toBeNull();
  });

  it('stops acting past the budget plus grace (replayed watcher)', () => {
    // The self-bound is the only protection against a watcher leaked
    // through a hard step kill acting on a LATER job of the same PR on
    // the reused runner: past budget + 30 minutes it returns without
    // polling the head at all.
    const expired = runWatcher({ runElapsed: 23401, attemptElapsed: 23401 });
    expect(expired.marker).toBeNull();
    expect(expired.superseded).toBeNull();
    expect(expired.pkilled).toBe(false);
  });

  it('ends a superseded attempt clean without retrying (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      // The watcher cedes mid-attempt (its pkill kills the qwen tree);
      // the attempt's post-run check sees the file and cedes clean.
      const r = runScenario('supersede_mid_attempt', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-b',
        },
      });
      expect(r.attempts).toBe(1);
      expect(r.status).toBe(0);
      expect(r.raw).toContain('Superseded early:');
      expect(r.raw).toContain('ceding to the replacement run (#10110)');
      expect(r.raw).not.toContain('FAIL ');
      // The supersede file is agent-writable: the stub planted a newline
      // plus a forged workflow command in it. Only the watcher's 40-hex
      // shape may reach the interpolated message — anything else degrades
      // to `unknown`, so no injected line starts a transcript line.
      expect(r.raw).toContain('to unknown before the salvage threshold');
      expect(
        r.raw.split('\n').some((l) => l.startsWith('::error::injected')),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cedes instead of retrying when salvage armed but the attempt died (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const salvageFile = join(dir, 'salvage-ok');
      // The stub arms the marker mid-attempt (stand-in for the watcher's
      // KEEP write, which the replay cannot inject), the attempt still dies
      // retryable, and the head has moved: a retry would re-review a
      // superseded head from scratch — one attempt, clean exit.
      // SLEEP_FAIL_AFTER=1 lets the armed watcher exactly one poll (it sees
      // the unmoved head, stands in for a KEEP it cannot decide here) and
      // then ends its loop; STUB_LIVE_HEAD_A1 answers that poll and the
      // loop's later live-head re-check gets the moved head.
      const r = runScenario('salvage_armed_then_die', {
        armWatcher: true,
        extraEnv: {
          QWEN_CI_REVIEW_SALVAGE_OK_FILE: salvageFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_GH_COUNT: join(dir, 'gh-count'),
          STUB_LIVE_HEAD_A1: 'head-a',
          STUB_LIVE_HEAD: 'head-b',
          SLEEP_FAIL_AFTER: '1',
        },
      });
      expect(r.attempts).toBe(1);
      expect(r.status).toBe(0);
      expect(r.raw).toContain('Salvage-armed review attempt did not complete');
      expect(r.raw).not.toContain('FAIL ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries and fails an explicit run whose salvage marker coincides with a head move (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const salvageFile = join(dir, 'salvage-ok');
      // R6-1 defense-in-depth: an explicit run has no watcher that could
      // legitimately arm the marker and no queued replacement to cede to,
      // so the same shape with the marker forged must burn its retry and
      // fail loudly instead of exiting green on the forgeable marker.
      const r = runScenario('salvage_armed_then_die', {
        extraEnv: {
          QWEN_CI_REVIEW_SALVAGE_OK_FILE: salvageFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-b',
        },
      });
      expect(r.attempts).toBe(2);
      expect(r.status).toBe(1);
      expect(r.raw).toContain('FAIL ');
      expect(r.raw).not.toContain(
        'Salvage-armed review attempt did not complete',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('completes normally when salvage armed and the attempt succeeds (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const salvageFile = join(dir, 'salvage-ok');
      writeFileSync(salvageFile, 'head-a');
      const r = runScenario('success', {
        extraEnv: { QWEN_CI_REVIEW_SALVAGE_OK_FILE: salvageFile },
      });
      expect(r.line).toBe('OK outcome=success');
      expect(r.status).toBe(0);
      expect(r.attempts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cedes before an attempt when the watcher yielded during the backoff (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      // Attempt 1 dies retryable; the stubbed backoff sleep stands in for
      // the window where the watcher cedes against an empty process table
      // (pkill matches nothing — qwen is not running). The top-of-loop
      // re-check must stop attempt 2 re-reviewing the dead head.
      const r = runScenario('supersede_during_backoff', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          SUPERSEDE_DURING_BACKOFF: supersedeFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-b',
        },
      });
      expect(r.attempts).toBe(1);
      expect(r.status).toBe(0);
      expect(r.raw).toContain('Superseded early:');
      expect(r.raw).not.toContain('FAIL ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets the salvage state before the retry backoff, not only at the loop top (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      const obs = join(dir, 'backoff-observed');
      // Attempt 1 reaches compose (latch + surviving artifact) and dies
      // retryable; the head move lands in the 60s backoff. The watcher
      // polls THROUGH the backoff, so it must meet already-reset state —
      // the stubbed backoff observes the reset and stands in for the
      // watcher's cede. Without the pre-backoff reset the latch/artifact
      // survive the backoff (observed `present`) and a real watcher arms
      // the salvage marker instead of ceding.
      const r = runScenario('compose_then_backoff_supersede', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          SUPERSEDE_DURING_BACKOFF: supersedeFile,
          BACKOFF_OBS: obs,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-b',
        },
      });
      expect(readFileSync(obs, 'utf8').trim()).toBe('absent');
      expect(r.attempts).toBe(1);
      expect(r.status).toBe(0);
      expect(r.raw).toContain('Superseded early:');
      expect(r.raw).not.toContain('FAIL ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not record a successful attempt as superseded when the cede write raced completion (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      // The watcher's one-shot CEDE writes the file and pkills; if the
      // pkill races — or misses — qwen's natural exit-0, the attempt
      // completes and posts. The post-attempt check carries the same
      // OUTCOME guard as its salvage-cede sibling and must not turn the
      // finished review into "Superseded early".
      const r = runScenario('supersede_after_success', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-b',
        },
      });
      expect(r.line).toBe('OK outcome=success');
      expect(r.status).toBe(0);
      expect(r.raw).not.toContain('Superseded early:');
      expect(r.attempts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not cede to a forged supersede file when the live head never moved (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      // Existence alone must not cede: the head never moved, so no
      // replacement run exists — a forged cede is a silent green
      // suppression of the whole review.
      writeFileSync(supersedeFile, 'head-b');
      const r = runScenario('success', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-a',
        },
      });
      expect(r.raw).not.toContain('Superseded early:');
      expect(r.line).toBe('OK outcome=success');
      expect(r.attempts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not cede to a supersede file forged mid-attempt when the head never moved (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      // Forged DURING the attempt (the post-attempt check site): same
      // silence risk — the head never moved, so the review must complete.
      const r = runScenario('supersede_forge_mid_attempt', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-a',
        },
      });
      expect(r.raw).not.toContain('Superseded early:');
      expect(r.line).toBe('OK outcome=success');
      expect(r.attempts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries and fails when the salvage marker is forged and the head never moved (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const salvageFile = join(dir, 'salvage-ok');
      writeFileSync(salvageFile, 'head-a');
      const r = runScenario('transient_persist', {
        extraEnv: {
          QWEN_CI_REVIEW_SALVAGE_OK_FILE: salvageFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-a',
        },
      });
      expect(r.attempts).toBe(2);
      expect(r.raw).toContain('FAIL ');
      expect(r.raw).not.toContain(
        'Salvage-armed review attempt did not complete',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets the compose latch between attempts (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const obs = join(dir, 'latch-observed');
      // Attempt 1 reaches compose (the stub simulates the watcher latching
      // it) and dies retryable; attempt 2 must start without the stale
      // latch, or it reads salvage-eligible from its first second.
      const r = runScenario('compose_latch_reset', {
        extraEnv: { OBS: obs },
      });
      expect(r.attempts).toBe(2);
      expect(readFileSync(obs, 'utf8').trim()).toBe('absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes a stale composed artifact in the per-attempt reset (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const obs = join(dir, 'artifact-observed');
      // Attempt 1 reaches compose and dies retryable, skipping the skill's
      // Step 9 cleanup; attempt 2 must not inherit the artifact, or the
      // watcher re-latches compose-seen from it within one poll and the
      // fresh attempt reads salvage-eligible from its first second.
      const r = runScenario('compose_artifact_reset', {
        extraEnv: { OBS: obs },
      });
      expect(r.attempts).toBe(2);
      expect(readFileSync(obs, 'utf8').trim()).toBe('absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cedes when the head moved inside the watcher poll gap (replayed loop)', () => {
    // The head moves and every watcher poll misses it (the extreme poll
    // gap: the watcher never gets a poll in before the attempt dies):
    // guard_pr_write exits 90, no signal file exists, and the attempt
    // surfaces a fatal. In an AUTO_REVIEW run the terminal fail must
    // re-read the live head — the queued replacement already covers it,
    // so the run cedes clean instead of going red on a genuine supersede.
    // SLEEP_FAIL_AFTER=0 ends the armed watcher's loop before its first
    // poll — the replay's stand-in for the gap.
    const moved = runScenario('hardexit', {
      armWatcher: true,
      extraEnv: {
        EXPECTED_HEAD_SHA: 'head-a',
        STUB_LIVE_HEAD: 'head-b',
        SLEEP_FAIL_AFTER: '0',
      },
    });
    expect(moved.attempts).toBe(1);
    expect(moved.status).toBe(0);
    expect(moved.raw).toContain('Superseded early:');
    expect(moved.raw).not.toContain('FAIL ');
    // R6-1: the same shape in an EXPLICIT run (no watcher, and no
    // replacement run queued) must fail loudly, never cede — ceding there
    // would claim a handoff to a run that does not exist and leave the
    // review silently unposted.
    const explicit = runScenario('hardexit', {
      extraEnv: { EXPECTED_HEAD_SHA: 'head-a', STUB_LIVE_HEAD: 'head-b' },
    });
    expect(explicit.attempts).toBe(1);
    expect(explicit.status).toBe(1);
    expect(explicit.raw).toContain('FAIL ');
    expect(explicit.raw).not.toContain('Superseded early:');
    // Control: an unmoved head keeps the red failure — the cede exists
    // for the superseded run, not as a universal failure escape.
    const unmoved = runScenario('hardexit', {
      extraEnv: { EXPECTED_HEAD_SHA: 'head-a', STUB_LIVE_HEAD: 'head-a' },
    });
    expect(unmoved.status).toBe(1);
    expect(unmoved.raw).toContain('FAIL ');
    expect(unmoved.raw).not.toContain('Superseded early:');
  });

  it('cedes a killed attempt whose superseding push reverted before the re-check (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      // The watcher ceded mid-attempt (file written, tree killed — the
      // attempt surfaces the kill as a fatal), then the push was
      // force-reverted before the post-attempt live-head re-check: the
      // re-check sees the restored head, but the timeline still carries
      // the FULL move-then-revert pair landing during this run — the
      // unforgeable witness that the run really was superseded. Timeline
      // lines are `beforeCommit afterCommit createdAt`, ascending.
      // SLEEP_FAIL_AFTER=0 keeps the armed watcher from polling (the loop
      // owns every gh call in the replay); AUTO_REVIEW is on because a
      // watcher kill is an AUTO_REVIEW story and the revert cede is gated
      // on it.
      writeFileSync(supersedeFile, 'head-b');
      const base = {
        SUPERSEDE_FILE: supersedeFile,
        EXPECTED_HEAD_SHA: 'head-a',
        STUB_LIVE_HEAD: 'head-a',
        REPO: 'o/r',
        SLEEP_FAIL_AFTER: '0',
      };
      const now = new Date().toISOString();
      const pair = `head-a head-x ${now}\nhead-x head-a ${now}`;
      const ceded = runScenario('cede_revert_kill', {
        armWatcher: true,
        extraEnv: { ...base, STUB_TIMELINE: pair },
      });
      expect(ceded.attempts).toBe(1);
      expect(ceded.status).toBe(0);
      expect(ceded.raw).toContain('Superseded early:');
      expect(ceded.raw).not.toContain('FAIL ');
      // A silent timeline (the verification unavailable) keeps the red
      // failure — the cede needs the unforgeable witness.
      const silent = runScenario('cede_revert_kill', {
        armWatcher: true,
        extraEnv: base,
      });
      expect(silent.status).toBe(1);
      expect(silent.raw).toContain('FAIL ');
      expect(silent.raw).not.toContain('Superseded early:');
      // A LONE back-push to the expected head proves nothing — it matches
      // the triggering push of a reopened/ready_for_review run, whose
      // event window reaches before the run started; only the departure
      // followed by the return is the move's signature.
      const loneBack = runScenario('cede_revert_kill', {
        armWatcher: true,
        extraEnv: { ...base, STUB_TIMELINE: `head-x head-a ${now}` },
      });
      expect(loneBack.status).toBe(1);
      expect(loneBack.raw).toContain('FAIL ');
      expect(loneBack.raw).not.toContain('Superseded early:');
      // A pair that landed BEFORE the run started proves nothing about a
      // move during it either (the old 300s window admitted it).
      const preRun = new Date(Date.now() - 200_000).toISOString();
      const preRunPair = `head-a head-x ${preRun}\nhead-x head-a ${preRun}`;
      const early = runScenario('cede_revert_kill', {
        armWatcher: true,
        extraEnv: { ...base, STUB_TIMELINE: preRunPair },
      });
      expect(early.status).toBe(1);
      expect(early.raw).toContain('FAIL ');
      expect(early.raw).not.toContain('Superseded early:');
      // A stale pair (2020) fails the window the same way.
      const stale = runScenario('cede_revert_kill', {
        armWatcher: true,
        extraEnv: {
          ...base,
          STUB_TIMELINE:
            'head-a head-x 2020-01-01T00:00:00Z\nhead-x head-a 2020-01-01T00:00:01Z',
        },
      });
      expect(stale.status).toBe(1);
      expect(stale.raw).toContain('FAIL ');
      // And a pair between two OTHER heads is not the move's signature.
      const other = runScenario('cede_revert_kill', {
        armWatcher: true,
        extraEnv: { ...base, STUB_TIMELINE: `deadbeef cafebabe ${now}` },
      });
      expect(other.status).toBe(1);
      expect(other.raw).toContain('FAIL ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relaunches a spent watcher and clears stale signals for a retry (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      const B40 = 'b'.repeat(40);
      // Attempt 1: the armed watcher sees a below-threshold head move
      // (first gh call) recording the SHORT head, writes the supersede
      // file and kills — but the head REVERTS before the re-check, so
      // the run retries instead of ceding. The retry must clear attempt
      // 1's file and relaunch the spent one-shot watcher: a head move
      // early in attempt 2 (gh serves the full live head from attempt 2
      // on) then lands a fresh CEDE within one poll. The two recorded
      // shapes make the difference observable — a surviving stale file
      // (no clear) or a missing relaunch degrades the cede's head to
      // `unknown` instead of the watcher's 40-hex recording.
      const r = runScenario('retry_watcher_relaunch', {
        armWatcher: true,
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_GH_COUNT: join(dir, 'gh-count'),
          STUB_LIVE_HEAD_A1: 'head-b',
          STUB_LIVE_HEAD: 'head-a',
          STUB_LIVE_HEAD_A2: B40,
        },
      });
      expect(r.attempts).toBe(2);
      expect(r.status).toBe(0);
      expect(r.raw).toContain('Superseded early:');
      expect(r.raw).toContain(`to ${B40} before the salvage threshold`);
      expect(r.raw).not.toContain('FAIL ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the previous attempt's supersede signal before a retry (replayed loop)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      const obs = join(dir, 'signal-observed');
      // A cede whose head reverted leaves the previous attempt's file
      // behind; the re-check sees the restored head and retries, so
      // attempt 2 must meet cleared state (the relaunch witness above
      // covers the watcher half; this pins the rm).
      writeFileSync(supersedeFile, 'head-b');
      const r = runScenario('retry_clears_stale_signals', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          OBS: obs,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-a',
        },
      });
      expect(r.attempts).toBe(2);
      expect(r.status).toBe(0);
      expect(r.line).toBe('OK outcome=success');
      expect(readFileSync(obs, 'utf8').trim()).toBe('absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives agent-planted directories at the salvage signal paths on a retry (replayed loop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
    try {
      const supersedeFile = join(dir, 'superseded');
      // The reviewed agent derives every signal path from its exported
      // environment and mkdir's them during attempt 1: a bare `rm -f` on a
      // directory exits 1 even with -f, and under the step's restored
      // errexit the reset would abort red instead of retrying. rm -rf must
      // absorb the plant and attempt 2 must run.
      const r = runScenario('retry_planted_dirs', {
        extraEnv: {
          SUPERSEDE_FILE: supersedeFile,
          EXPECTED_HEAD_SHA: 'head-a',
          STUB_LIVE_HEAD: 'head-a',
        },
      });
      expect(r.attempts).toBe(2);
      expect(r.status).toBe(0);
      expect(r.line).toBe('OK outcome=success');
      expect(r.raw).not.toContain('FAIL ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a deleted SALVAGE_DIR across the retry reset (replayed loop)', () => {
    // The deletion dual: the agent removes SALVAGE_DIR outright during
    // attempt 1. The reset's attempt-start rewrite must be best-effort —
    // an unguarded write_signal fails its mktemp and aborts the retry
    // under errexit; the watcher's START_TS fallback covers the lost file.
    const r = runScenario('retry_deleted_salvage_dir', {
      extraEnv: { EXPECTED_HEAD_SHA: 'head-a', STUB_LIVE_HEAD: 'head-a' },
    });
    expect(r.attempts).toBe(2);
    expect(r.status).toBe(0);
    expect(r.line).toBe('OK outcome=success');
    expect(r.raw).not.toContain('FAIL ');
  });

  it('pins the compose-artifact path to the CLI that writes it', () => {
    // The watcher's strongest KEEP signal is the composed-verdict artifact;
    // its name comes from composedNameFor in the review CLI. If either side
    // renames, this cross-pin fails instead of the signal silently dying
    // (the elapsed threshold would still salvage, but later than intended).
    expect(run).toContain(
      'COMPOSED_ARTIFACT="${GITHUB_WORKSPACE}/.qwen/tmp/qwen-review-pr-${PR_NUMBER}-composed.json"',
    );
    const cli = readFileSync('packages/cli/src/commands/review/run.ts', 'utf8');
    expect(cli).toContain('`qwen-review-pr-${cls.number}-composed.json`');
  });

  it('bounds and scopes the watcher kill', () => {
    // -U scopes to the runner user; the trailing ($|[^0-9]) keeps PR 123
    // from matching PR 1234's URL; TERM first, KILL after a grace period.
    expect(run).toContain(
      'pkill -U "$(id -u)" -TERM -f "${REVIEW_URL}($|[^0-9])"',
    );
    expect(run).toContain(
      'pkill -U "$(id -u)" -KILL -f "${REVIEW_URL}($|[^0-9])"',
    );
    // Self-bounded past the budget, and reaped on every exit path — a
    // watcher outliving the step on a reused self-hosted runner could kill
    // a later job's review of the same PR.
    expect(run).toContain('BUDGET_SECONDS + 1800');
    expect(run).toContain(
      '[ -z "${WATCHER_PID:-}" ] || kill "${WATCHER_PID}" 2>/dev/null || true',
    );
  });

  it('reaps an already-exited watcher without failing the clean cede', () => {
    // Salvage arming exits the watcher on the spot; the cede path's
    // deliberate `exit 0` then runs the trap AFTER bash reaped the
    // subshell. The kill must not turn that clean exit into exit 1 under
    // the step's errexit, nor skip the SALVAGE_DIR cleanup.
    const trapLine = run.split('\n').find((l) => l.startsWith("trap '"));
    expect(trapLine).toContain("' EXIT");
    const runTrap = (plantLogDir) => {
      const dir = mkdtempSync(join(tmpdir(), 'review-salvage-'));
      try {
        const harness = [
          'set -euo pipefail',
          `LOG_PATH="${join(dir, 'log')}"`,
          plantLogDir ? 'mkdir -p "$LOG_PATH"' : ': > "$LOG_PATH"',
          'PROXY_BIN=""',
          `SALVAGE_DIR="${join(dir, 'salvage')}"; mkdir -p "$SALVAGE_DIR"`,
          '( : ) &',
          'WATCHER_PID=$!',
          'wait "$WATCHER_PID"',
          trapLine,
          'exit 0',
        ].join('\n');
        const r = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(existsSync(join(dir, 'salvage'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    runTrap(false);
    // LOG_PATH is agent-derivable (RUNNER_TEMP + PR number): a planted
    // DIRECTORY there must not abort the trap's first clause and leak the
    // watcher reap / SALVAGE_DIR cleanup (rm -f exits 1 on a directory).
    runTrap(true);
  });

  it('wires the salvage outputs into the historical-head note step', () => {
    expect(run).toContain('echo "salvaged=true"');
    expect(run).toContain('salvage_moved_to=');
    const note = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Report salvaged historical-head review',
    );
    expect(note).toBeTruthy();
    expect(note.env.MOVED_TO).toBe(
      '${{ steps.review.outputs.salvage_moved_to }}',
    );
    expect(note.if).toContain("steps.review.outputs.salvaged == 'true'");
    expect(note.if).toContain(
      "steps.review.outputs.review_completed == 'true'",
    );
    // Docs-only medium never posts, so a "posted against" note would be
    // false there.
    expect(note.if).toContain(
      "steps.review.outputs.docs_only_medium != 'true'",
    );
    expect(note.run).toContain('<!-- qwen-review-salvaged');
  });

  // The marker -> outputs block sits OUTSIDE the retry-loop extraction
  // window (the window ends at the loop's column-0 `done`), so pin it by
  // executing it — a flipped marker condition or an unvalidated moved-to
  // ships green under shape checks alone.
  function salvageOutputsSource() {
    const start = run.indexOf(
      'if [ -f "$QWEN_CI_REVIEW_SALVAGE_OK_FILE" ] && live_head_moved; then',
    );
    const end = run.indexOf('\nfi', start) + '\nfi'.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return run.slice(start, end);
  }

  function liveHeadMovedSource() {
    return run.match(/live_head_moved\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  }

  function readHeadSignalSource() {
    return run.match(/read_head_signal\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  }

  function runSalvageOutputs({
    marker = 'head-a',
    movedTo = null,
    liveHead = 'head-b',
    movedToFifo = false,
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'review-salvage-out-'));
    try {
      const salvage = join(dir, 'salvage');
      mkdirSync(salvage);
      if (marker !== null) writeFileSync(join(salvage, 'salvage-ok'), marker);
      if (movedToFifo) {
        execFileSync('mkfifo', [join(salvage, 'moved-to')]);
      } else if (movedTo !== null) {
        writeFileSync(join(salvage, 'moved-to'), movedTo);
      }
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const ghPath = join(bin, 'gh');
      writeFileSync(ghPath, `#!/bin/bash\necho "${liveHead}"\n`);
      chmodSync(ghPath, 0o755);
      const gho = join(dir, 'gho');
      const harness = [
        'set -euo pipefail',
        liveHeadMovedSource(),
        readHeadSignalSource(),
        'PR_NUMBER=1; REPO=o/r; EXPECTED_HEAD_SHA=head-a',
        `SALVAGE_DIR="${salvage}"`,
        `QWEN_CI_REVIEW_SALVAGE_OK_FILE="${salvage}/salvage-ok"`,
        `GITHUB_OUTPUT="${gho}"; : > "$GITHUB_OUTPUT"`,
        salvageOutputsSource(),
      ].join('\n');
      execFileSync('bash', ['-c', harness], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      return readFileSync(gho, 'utf8').split('\n').filter(Boolean);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes the salvage outputs only for an armed marker and a real move (replayed block)', () => {
    const sha = 'b'.repeat(40);
    expect(runSalvageOutputs({ movedTo: sha })).toEqual([
      'salvaged=true',
      `salvage_moved_to=${sha}`,
    ]);
    // No marker: an ordinary run emits neither output (a flipped condition
    // would post the historical-head note on every run).
    expect(runSalvageOutputs({ marker: null })).toEqual([]);
    // Marker armed but the watcher died before recording a destination.
    expect(runSalvageOutputs({})).toEqual([
      'salvaged=true',
      'salvage_moved_to=unknown',
    ]);
    // Forged marker, head NEVER moved: the outputs block follows the cede
    // sites' live-head re-check — no outputs, and the historical-head
    // note never posts on an unmoved PR. A failed gh read at decision
    // time (empty output) falls the same way.
    expect(runSalvageOutputs({ liveHead: 'head-a' })).toEqual([]);
    expect(runSalvageOutputs({ liveHead: '' })).toEqual([]);
    // A FIFO planted at moved-to must not hang the finished step; the
    // [ -f ] gate degrades the read to unknown (bounded by the timeout).
    expect(runSalvageOutputs({ movedToFifo: true })).toEqual([
      'salvaged=true',
      'salvage_moved_to=unknown',
    ]);
  });

  it('degrades a forged moved-to instead of injecting outputs (replayed block)', () => {
    // moved-to is agent-writable; embedded newlines would land as forged
    // name=value lines in $GITHUB_OUTPUT and flip gates like
    // docs_only_medium. Only the watcher's 40-hex shape passes.
    const forged = `${'a'.repeat(40)}\ndocs_only_medium=true\ncompletion_line=forged`;
    expect(runSalvageOutputs({ movedTo: forged })).toEqual([
      'salvaged=true',
      'salvage_moved_to=unknown',
    ]);
    expect(runSalvageOutputs({ movedTo: 'a'.repeat(41) })).toEqual([
      'salvaged=true',
      'salvage_moved_to=unknown',
    ]);
  });

  it('reads the salvage threshold from the repo variable with a 50 default', () => {
    const env = doc.jobs['review-pr'].steps.find(
      (s) => s.name === 'Run review',
    ).env;
    expect(env.SALVAGE_ELAPSED_PERCENT_VAR).toBe(
      '${{ vars.QWEN_REVIEW_SALVAGE_ELAPSED_PERCENT }}',
    );
    expect(run).toContain('SALVAGE_ELAPSED_PERCENT=50');
  });

  it('sanitizes the salvage percent to a clamped decimal (replayed parse)', () => {
    // The parse sits OUTSIDE the retry-loop extraction window, so pin its
    // behavior by executing it: the digit guard, the 100 clamp, and the
    // decimal coercion a leading-zero value needs before $(( )) reads it.
    const start = run.indexOf(
      'SALVAGE_ELAPSED_PERCENT="${SALVAGE_ELAPSED_PERCENT_VAR:-}"',
    );
    const clamp = run.indexOf(
      'if [ "$SALVAGE_ELAPSED_PERCENT" -gt 100 ]',
      start,
    );
    const end = run.indexOf('\nfi', clamp) + '\nfi'.length;
    expect(start).toBeGreaterThan(-1);
    expect(clamp).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(clamp);
    const block = run.slice(start, end);
    const parsePct = (value) =>
      execFileSync(
        'bash',
        [
          '-c',
          `set -euo pipefail\n${block}\nprintf '%s' "$SALVAGE_ELAPSED_PERCENT"`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SALVAGE_ELAPSED_PERCENT_VAR: value },
        },
      );
    expect(parsePct('30')).toBe('30');
    expect(parsePct('')).toBe('50');
    expect(parsePct('abc')).toBe('50');
    expect(parsePct('150')).toBe('100');
    expect(parsePct('08')).toBe('8');
    expect(parsePct('050')).toBe('50');
  });

  it('skips a queued run whose event head went stale before review-pr spends setup', () => {
    // With cancel-in-progress scoped to `closed`, a synchronize run can wait
    // PENDING behind an in-flight review and outlive its own head; the delay
    // job's re-check is the cheap exit before review-pr's runner setup.
    const delay = doc.jobs['delay-automatic-review'].steps.find(
      (s) => s.id === 'pr_state',
    );
    expect(delay.env.EVENT_HEAD_SHA).toBe(
      '${{ github.event.pull_request.head.sha }}',
    );
    expect(delay.run).toContain('while this run queued');
    expect(delay.run).toContain('should_review=false');
    // The comparison direction is load-bearing — a one-keystroke
    // `!=` → `=` flip makes every run whose head did NOT move skip
    // itself, silently ending all delayed automatic reviews — so pin
    // the condition verbatim, not just its echo strings.
    expect(delay.run).toContain(
      'if [ -n "$EVENT_HEAD_SHA" ] && [ -n "$current_head" ] && [ "$current_head" != "$EVENT_HEAD_SHA" ]; then',
    );
  });
});
