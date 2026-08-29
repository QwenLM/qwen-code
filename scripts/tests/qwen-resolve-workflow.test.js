/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// Capability probe, not a platform check: the FIFO wedge tests need
// mkfifo(1), which macOS does not ship — the merge_group-gated test_macos
// lane still runs this suite (vitest.config excludes win32 only), where
// spawnSync('mkfifo', ...) returns ENOENT without throwing, no FIFO is
// ever created, and the wedge assertions would pass for the wrong reason
// (R11-7).
const hasMkfifo = (() => {
  try {
    execFileSync('mkfifo', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start === -1) {
    return '';
  }
  const nextJob = workflow.slice(start + 1).search(/\n {2}\S/);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + 1 + nextJob);
}

function step(section, name) {
  const escaped = escapeRegExp(name);
  const match = section.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|\\n\\s{2}[a-zA-Z0-9_-]+:|$)`,
    ),
  );
  return match?.[0] ?? '';
}

function reviewGhWrapper(runStep) {
  const start = runStep.indexOf('cat > "$proxy_bin/gh" <<\'QWEN_GH_WRAPPER\'');
  const bodyStart = runStep.indexOf('\n', start) + 1;
  const end = runStep.indexOf('\n          QWEN_GH_WRAPPER', bodyStart);
  return runStep.slice(bodyStart, end).replace(/^ {10}/gm, '');
}

// A timeout(1) stub that ENFORCES the bound: the wrapper's salvage marker
// read is a `timeout 5 head -c 128` open, and a lane without GNU coreutils
// (macOS) ships no timeout(1). A bare pass-through is not sufficient: a
// rename-swapped FIFO then blocks the open forever (R8-10).
function boundedTimeoutStub() {
  const js =
    'const [dur, ...cmd] = process.argv.slice(1);' +
    'const ms = Math.max(0, Number.parseFloat(dur) || 0) * 1000;' +
    'const child = require("child_process").spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });' +
    'let killed = false;' +
    'const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch (e) {} }, ms);' +
    'child.on("exit", (code, signal) => { clearTimeout(timer); process.exit(killed ? 124 : code === null ? (signal ? 137 : 1) : code); });';
  return `#!/bin/bash\nexec "${process.execPath}" -e '${js}' "$@"\n`;
}

// A reader stub (installed as head AND cat) that rename-swaps a FIFO onto
// its target at open time — the window [ -f ] cannot refuse — then blocks
// like a real open (no writer). Only a timeout bound resolves the read;
// shimming both readers keeps the wedge red for a regression back to a
// bare `cat`.
function swapAtOpenStub() {
  return (
    [
      '#!/bin/bash',
      'for last in "$@"; do :; done',
      'if [ -n "$last" ] && [ -f "$last" ]; then',
      '  rm -f "$last"',
      '  mkfifo "$last"',
      'fi',
      'exec cat "$last"',
    ].join('\n') + '\n'
  );
}

function runReviewGhWrapper(
  runStep,
  args,
  prState,
  currentHead,
  expectedHead = 'head-a',
  // salvageContent: when set, a salvage marker file with that content is
  // created and exported as QWEN_CI_REVIEW_SALVAGE_OK_FILE — the supersede
  // watcher's past-threshold pin (#10110). salvageFifo plants a static
  // FIFO at the marker; swapSalvageOnRead rename-swaps one in at the
  // read's open — the window [ -f ] cannot refuse (R8-10).
  { salvageContent, salvageFifo = false, swapSalvageOnRead = false } = {},
) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-review-gh-'));
  try {
    const wrapperPath = path.join(tempDir, 'gh');
    const realGhPath = path.join(tempDir, 'real-gh');
    const ghLogPath = path.join(tempDir, 'gh.log');
    let salvagePath = '';
    if (salvageFifo) {
      salvagePath = path.join(tempDir, 'salvage-ok');
      spawnSync('mkfifo', [salvagePath]);
    } else if (salvageContent !== undefined) {
      salvagePath = path.join(tempDir, 'salvage-ok');
      writeFileSync(salvagePath, salvageContent);
    }
    writeFileSync(wrapperPath, reviewGhWrapper(runStep));
    writeFileSync(
      realGhPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ]; then',
        '  printf "%s\\t%s\\n" "${FAKE_PR_STATE:-OPEN}" "${FAKE_HEAD_SHA:-head-a}"',
        '  exit 0',
        'fi',
        'printf "%s\\n" "$*" >> "${FAKE_GH_LOG:?}"',
      ].join('\n'),
    );
    writeFileSync(ghLogPath, '');
    chmodSync(wrapperPath, 0o755);
    chmodSync(realGhPath, 0o755);
    // The marker read is a bounded `timeout 5 head -c 128` open: give the
    // wrapper a bound-enforcing timeout(1) on every lane (macOS ships
    // none) — and the swap head stub when the wedge arm is requested.
    const binDir = path.join(tempDir, 'bin');
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, 'timeout'), boundedTimeoutStub());
    chmodSync(path.join(binDir, 'timeout'), 0o755);
    if (swapSalvageOnRead) {
      for (const name of ['head', 'cat']) {
        writeFileSync(path.join(binDir, name), swapAtOpenStub());
        chmodSync(path.join(binDir, name), 0o755);
      }
    }

    const result = spawnSync(wrapperPath, args, {
      encoding: 'utf8',
      // A regression that unbounds the marker read must turn the suite
      // RED on the harness bound, not hang it: spawnSync kills the child
      // at 30s and the status assertions fail on the missing exit.
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GH_LOG: ghLogPath,
        FAKE_HEAD_SHA: currentHead,
        FAKE_PR_STATE: prState,
        QWEN_CI_REAL_GH: realGhPath,
        QWEN_CI_REVIEW_EXPECTED_HEAD_SHA: expectedHead,
        QWEN_CI_REVIEW_PR_NUMBER: '123',
        QWEN_CI_REVIEW_REPO: 'owner/repo',
        ...(salvagePath ? { QWEN_CI_REVIEW_SALVAGE_OK_FILE: salvagePath } : {}),
      },
    });

    return {
      ...result,
      ghLog: readFileSync(ghLogPath, 'utf8'),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('qwen resolve workflow', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/qwen-code-pr-review.yml'),
    'utf8',
  );

  it('serialises /resolve against the autofix conflict path on the same PR head', () => {
    // Both jobs merge the base branch and push to the PR's head. They live in
    // different workflows, so a per-workflow concurrency name guards each only
    // against itself. Observed on #7355: /resolve pushed at 03:51, the autofix
    // leg pushed at 04:05 and was rejected `fetch first`, throwing away a full
    // agent run. GitHub concurrency groups are repository-scoped, so an
    // IDENTICAL prefix in both files is what makes them mutually exclusive.
    const autofix = readFileSync(
      path.join(repoRoot, '.github/workflows/qwen-autofix.yml'),
      'utf8',
    );
    const groupOf = (text, jobName) =>
      job(text, jobName).match(
        /\n {4}concurrency:\n {6}group: '([a-z-]+?)-\$\{\{/,
      )?.[1];

    const resolveLock = groupOf(workflow, 'resolve-pr');
    const autofixLock = groupOf(autofix, 'review-address');
    expect(resolveLock).toBeTruthy();
    // The invariant: renaming one side alone silently re-opens the race, and
    // nothing else in the suite would notice.
    expect(autofixLock).toBe(resolveLock);

    // Each side must still key the group on the PR number — a shared prefix
    // with a per-run suffix would serialise nothing.
    expect(job(workflow, 'resolve-pr')).toContain(
      `group: '${resolveLock}-\${{ github.event.issue.number || github.event.inputs.pr_number }}'`,
    );
    expect(job(autofix, 'review-address')).toContain(
      `group: '${autofixLock}-\${{ matrix.target.pr }}'`,
    );
    // Queue, never cancel: the loser of the race must run after the winner and
    // re-check, not be discarded (or discard the winner's in-flight work).
    for (const [text, name] of [
      [workflow, 'resolve-pr'],
      [autofix, 'review-address'],
    ]) {
      expect(job(text, name)).toContain('cancel-in-progress: false');
    }
  });

  it('uses the existing PR command workflow', () => {
    expect(
      existsSync(
        path.join(repoRoot, '.github/workflows/qwen-fix-conflicts.yml'),
      ),
    ).toBe(false);
    expect(workflow).toContain('issue_comment:');
    expect(workflow).toContain("github.event.inputs.command == 'resolve'");
    expect(workflow).toContain('github.event.issue.pull_request');
    expect(workflow).toContain("github.event.issue.state == 'open'");
    expect(workflow).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /resolve')",
    );
    expect(workflow).toContain('needs.authorize.outputs.should_review');
    expect(workflow).not.toContain('authorize-resolve:');
    expect(workflow).toContain(
      "github.event.comment.body == '@qwen-code /resolve'",
    );
  });

  it('cancels in-flight lifecycle reviews when the PR closes', () => {
    const concurrencyStart = workflow.indexOf('\nconcurrency:');
    const concurrency = workflow.slice(
      concurrencyStart,
      workflow.indexOf('\njobs:', concurrencyStart),
    );

    expect(workflow).toContain("- 'closed'");
    expect(concurrency).toContain("github.event.action == 'closed'");
    expect(concurrency).toContain(
      "format('qwen-pr-review-pr-{0}', github.event.pull_request.number)",
    );
  });

  it('cancels in progress on closed only — synchronize supersede is decided in-run (#10110)', () => {
    const concurrencyStart = workflow.indexOf('\nconcurrency:');
    const concurrency = workflow.slice(
      concurrencyStart,
      workflow.indexOf('\njobs:', concurrencyStart),
    );

    // Verbatim: re-adding `synchronize` here silently reinstates the
    // declarative cancel that discarded a 4h06m review minutes from posting
    // (PR #9729, run 32726618419). A push now queues PENDING in the PR group
    // while the in-flight run's supersede watcher decides KEEP (salvage past
    // the threshold, post against the reviewed head) vs CEDE (end early);
    // `closed` still cancels — a closed PR's review is pointless and its
    // posting is blocked by the OPEN guard anyway.
    expect(concurrency).toContain(
      "cancel-in-progress: \"${{ github.event_name == 'pull_request_target' && github.event.action == 'closed' }}\"",
    );
  });

  it('listens for /resolve comments', () => {
    expect(workflow).toContain(
      "github.event.comment.body == '@qwen-code /resolve'",
    );
    expect(workflow).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /resolve ')",
    );
    expect(workflow).toContain("format('@qwen-code /resolve{0}',");
    expect(workflow).not.toContain('/fix_conflicts');
  });

  it('reports failure paths instead of falling through silently', () => {
    expect(workflow).toContain("- name: 'Report result'");
    expect(workflow).toContain(
      'Qwen Code attempted to resolve merge conflicts but the run did not complete successfully.',
    );
    expect(workflow).toContain('push_failed=false');
    expect(workflow).toContain('push_failed=true');
    expect(workflow).toContain('Check the [workflow run]');
    // Report-skipped-request must run even when the prepare step crashes — its
    // always() gate is what lets the EXIT-trap decision=failed actually report.
    expect(resolveJob).toContain('Report skipped request');
    expect(resolveJob).toContain(
      "always() && (steps.prepare.outputs.decision == 'skip'",
    );
  });

  it('fails unknown conflict detection explicitly', () => {
    expect(workflow).toContain('if [ "$conflict" = "unknown" ]; then');
    expect(workflow).toContain('Could not determine conflict status');
  });

  it('only resolves conflicts — runs no build, typecheck, lint, test, or install', () => {
    expect(resolveJob).not.toContain('npm run build');
    expect(resolveJob).not.toContain('npm run typecheck');
    expect(resolveJob).not.toContain('npm run lint');
    expect(resolveJob).not.toContain('npm run test');
    expect(resolveJob).not.toContain("- name: 'Install dependencies'");
    expect(resolveJob).not.toContain("- name: 'Refresh dependencies'");
  });

  it('asks the resolution report for what the diff cannot show', () => {
    // Measured before this contract existed: every substantive /resolve
    // summary was a file-by-file inventory that hit the byte cap exactly and
    // stopped mid-word (#2993, #4256, #6206 all ended at 2100 bytes total).
    // The inventory duplicates the diff; what only the resolver knows is the
    // root cause, whether the merge was semantic, and what it could not check.
    const prompt = step(resolveJob, 'Resolve conflicts');
    expect(prompt).toContain('Keep the summary under 4000 bytes');
    expect(prompt).toContain(
      'A file-by-file inventory is the first thing to cut',
    );
    expect(prompt).toContain('**Root cause.**');
    expect(prompt).toContain('**Textual or semantic.**');
    expect(prompt).toContain('**What is load-bearing.**');
    expect(prompt).toContain('**What you could not verify.**');
    // /resolve runs no tests AND may not edit non-conflicted files, so a merge
    // that breaks an untouched test can only be reported, never fixed here.
    expect(prompt).toContain('NON-conflicted test');
    // Project convention for anything posted as a PR comment.
    expect(prompt).toContain('<summary>中文说明</summary>');
  });

  it('truncates an over-long report visibly, on a character boundary', () => {
    const helper = resolveJob.match(
      /(SUMMARY_MAX_BYTES=\d+\n[\s\S]*?append_safe_file\(\) \{[\s\S]*?\n {10}\})/,
    )?.[1];
    expect(helper).toBeTruthy();
    // The instructed limit must sit BELOW the enforced one, or a report that
    // obeys the prompt still gets cut.
    const cap = Number(helper.match(/SUMMARY_MAX_BYTES=(\d+)/)[1]);
    expect(cap).toBeGreaterThan(4000);

    const run = (body) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'resolve-summary-'));
      writeFileSync(path.join(dir, 'address-summary.md'), body);
      const out = spawnSync(
        'bash',
        [
          '-c',
          `${helper.replace(/^ {10}/gm, '')}\nappend_safe_file "$WORKDIR/address-summary.md"`,
        ],
        {
          env: {
            ...process.env,
            WORKDIR: dir,
            RUN_URL: 'https://github.com/test/repo/actions/runs/1',
          },
        },
      );
      rmSync(dir, { recursive: true, force: true });
      expect(out.status).toBe(0);
      return out.stdout;
    };

    // A report inside the budget is passed through whole and unannotated.
    const short = new TextDecoder().decode(
      run('# Merge report\n\nRoot cause: #7351 touched the same chain.\n'),
    );
    expect(short).toContain('Root cause: #7351 touched the same chain.');
    expect(short).not.toContain('truncated at');

    // An over-long one is cut AND says so — the silent stop is the bug.
    const long = new TextDecoder().decode(run(`${'x'.repeat(cap + 500)}\n`));
    expect(long).toContain(`truncated at ${cap} bytes`);
    expect(long).toContain('attached to this [workflow run](');

    // The cut lands on a byte boundary, so a multi-byte character straddling
    // it must be dropped rather than emitted as a broken tail. One leading
    // ASCII byte offsets the 3-byte characters so the cap falls INSIDE one —
    // without the offset the cut would land cleanly and prove nothing.
    const wideBuf = run(`x${'中'.repeat(Math.ceil(cap / 3) + 2)}`);
    // Fatal-decode the raw bytes bash emitted: a split multi-byte character
    // would throw here. Re-encoding a JS string first (TextEncoder) can never
    // produce invalid UTF-8, so that round-trip would make this assertion inert.
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(wideBuf),
    ).not.toThrow();
    const wide = new TextDecoder().decode(wideBuf);
    expect(wide).not.toContain('�');
    expect(wide).toContain(`truncated at ${cap} bytes`);
  });

  it('uses resolve naming for run artifacts', () => {
    expect(workflow).toContain('qwen-resolve-');
    expect(workflow).toContain('/tmp/qwen-resolve');
    expect(workflow).toContain('<!-- qwen-resolve-result -->');
    expect(workflow).not.toContain('qwen-fix-conflicts');
  });

  it('isolates review agent state per run', () => {
    const cleanStep = step(reviewJob, 'Clean stale agent state');
    const agentStep = step(reviewJob, 'Run review');

    expect(cleanStep).toContain('QWEN_HOME="${RUNNER_TEMP:?}/qwen-home"');
    expect(cleanStep).toContain('rm -rf "$QWEN_HOME"');
    expect(cleanStep).toContain('mkdir -p "$QWEN_HOME"');
    expect(cleanStep).toContain('rm -f /tmp/stage-*.md');
    expect(cleanStep).toContain('echo "stale agent state cleaned"');
    expect(agentStep).toContain("QWEN_HOME: '${{ runner.temp }}/qwen-home'");
  });

  it('allows maintainers to extend review timeout from /review comments', () => {
    const contextStep = step(reviewJob, 'Resolve PR context');
    const runStep = step(reviewJob, 'Run review');

    expect(reviewJob).toContain(
      "timeout-minutes: '${{ fromJSON(vars.QWEN_REVIEW_JOB_TIMEOUT_MINUTES) }}'",
    );
    expect(contextStep).toContain('DEFAULT_TIMEOUT_MINUTES=180');
    expect(contextStep).toContain('case "$token" in');
    expect(contextStep).toContain('--timeout=*)');
    expect(contextStep).toContain('TIMEOUT_MINUTES="${token#--timeout=}"');
    expect(contextStep).toContain('timeout=*)');
    expect(contextStep).toContain('TIMEOUT_MINUTES="${token#timeout=}"');
    expect(runStep).toContain('if [ "${#TIMEOUT_MINUTES}" -gt 3 ]; then');
    // The cap still comes from the repository variable, but reaches the script
    // through the step's env: the run body must stay free of `${{ }}` or the
    // whole workflow exceeds the 21000-character expression limit and becomes
    // invalid. Both halves are asserted so neither can drift alone.
    expect(runStep).toContain('MAX_TIMEOUT_MINUTES="$MAX_TIMEOUT_MINUTES_VAR"');
    expect(runStep).toContain(
      "MAX_TIMEOUT_MINUTES_VAR: '${{ vars.QWEN_REVIEW_MAX_TIMEOUT_MINUTES }}'",
    );
    expect(runStep).toContain(
      'if [ "$TIMEOUT_MINUTES" -gt "$MAX_TIMEOUT_MINUTES" ]; then',
    );
    expect(runStep).toContain(
      'fail "timeout_minutes must not exceed ${MAX_TIMEOUT_MINUTES} minutes"',
    );
    expect(runStep).toContain('QWEN_TIMEOUT="$EFFECTIVE_TIMEOUT_MINUTES"');
    expect(runStep).not.toContain('QWEN_TIMEOUT=$((TIMEOUT_MINUTES - 5))');
  });

  it('tiers the default review timeout by PR size unless overridden', () => {
    const contextStep = step(reviewJob, 'Resolve PR context');
    const runStep = step(reviewJob, 'Run review');

    // The context step records whether the caller chose a timeout explicitly.
    expect(contextStep).toContain('TIMEOUT_EXPLICIT=false');
    expect(contextStep).toContain('TIMEOUT_EXPLICIT=true');
    expect(contextStep).toContain('echo "timeout_explicit=$TIMEOUT_EXPLICIT"');
    expect(runStep).toContain(
      "TIMEOUT_EXPLICIT: '${{ steps.context.outputs.timeout_explicit }}'",
    );

    // Auto-tiering only applies without an explicit --timeout, keys off
    // additions + deletions, and never exceeds the QWEN_REVIEW_MAX_TIMEOUT_MINUTES
    // cap: small PRs keep 180, anything larger gets the full cap.
    expect(runStep).toContain('EFFECTIVE_TIMEOUT_MINUTES="$TIMEOUT_MINUTES"');
    expect(runStep).toContain(
      'if [ "${TIMEOUT_EXPLICIT:-false}" != "true" ]; then',
    );
    expect(runStep).toContain('--json additions,deletions');
    expect(runStep).toContain('if [ -n "$PR_SIZE_LINES" ]; then');
    expect(runStep).toContain('if [ "$PR_SIZE_LINES" -le 300 ]; then');
    // The size guard must WRAP the comparison it protects: swapping the two
    // ifs keeps both texts present while an empty PR_SIZE_LINES (a failed
    // size lookup) hits the bare integer test and silently gets the cap.
    const sizeGuardStart = runStep.indexOf('if [ -n "$PR_SIZE_LINES" ]; then');
    expect(sizeGuardStart).toBeGreaterThan(-1);
    const sizeGuardArm = runStep.slice(
      sizeGuardStart,
      runStep.indexOf('else', sizeGuardStart),
    );
    expect(sizeGuardArm).toContain('if [ "$PR_SIZE_LINES" -le 300 ]; then');
    expect(runStep).toContain('EFFECTIVE_TIMEOUT_MINUTES=180');
    expect(runStep).toContain(
      'EFFECTIVE_TIMEOUT_MINUTES="$MAX_TIMEOUT_MINUTES_VAR"',
    );
    expect(runStep).toContain(
      "MAX_TIMEOUT_MINUTES_VAR: '${{ vars.QWEN_REVIEW_MAX_TIMEOUT_MINUTES }}'",
    );
    // Slice the small-PR arm so a swap of the two assignments between the
    // branches fails: unordered containment keeps both texts present.
    const smallPrStart = runStep.indexOf(
      'if [ "$PR_SIZE_LINES" -le 300 ]; then',
    );
    expect(smallPrStart).toBeGreaterThan(-1);
    const smallPrArm = runStep.slice(
      smallPrStart,
      runStep.indexOf('else', smallPrStart),
    );
    expect(smallPrArm).toContain('EFFECTIVE_TIMEOUT_MINUTES=180');
    expect(smallPrArm).not.toContain('MAX_TIMEOUT_MINUTES_VAR');
    expect(runStep).not.toContain('EFFECTIVE_TIMEOUT_MINUTES=210');
    expect(runStep).toContain(
      'echo "effective_timeout_minutes=$EFFECTIVE_TIMEOUT_MINUTES"',
    );
    // Every check above is order-independent containment: pin that both
    // tiering writes precede both consumers, or a block moved below its
    // consumer keeps the suite green while non-small PRs run on the
    // pre-tier budget (the exact incident this feature exists for).
    const tierInit = runStep.indexOf(
      'EFFECTIVE_TIMEOUT_MINUTES="$TIMEOUT_MINUTES"',
    );
    const tierStart = runStep.indexOf(
      'if [ "${TIMEOUT_EXPLICIT:-false}" != "true" ]; then',
    );
    for (const consumer of [
      runStep.indexOf('QWEN_TIMEOUT="$EFFECTIVE_TIMEOUT_MINUTES"'),
      runStep.indexOf(
        'echo "effective_timeout_minutes=$EFFECTIVE_TIMEOUT_MINUTES"',
      ),
    ]) {
      expect(tierInit).toBeLessThan(consumer);
      expect(tierStart).toBeLessThan(consumer);
    }
  });

  it('tells maintainers how to retry timed-out reviews with more time', () => {
    const runStep = step(reviewJob, 'Run review');
    const fallbackStep = step(reviewJob, 'Post fallback comment on failure');

    expect(runStep).toContain('failure_kind=$kind');
    expect(runStep).toContain("OUTCOME='timeout'");
    expect(runStep).toContain(
      'REASON="Qwen review timed out after ${attempt_timeout} seconds (of the ${QWEN_TIMEOUT}-minute budget)."',
    );
    expect(runStep).toContain('[ "$qwen_status" -eq 137 ]');
    expect(fallbackStep).toContain('failure() &&');
    expect(fallbackStep).toContain(
      'FAILURE_KIND: "${{ steps.review.outputs.failure_kind || \'\' }}"',
    );
    expect(fallbackStep).toContain('TIMEOUT_MINUTES:');
    expect(fallbackStep).toContain(
      "TIMEOUT_MINUTES: '${{ steps.review.outputs.effective_timeout_minutes || steps.context.outputs.timeout_minutes }}'",
    );
    expect(fallbackStep).toContain(
      'MAX_TIMEOUT_MINUTES="${{ vars.QWEN_REVIEW_MAX_TIMEOUT_MINUTES }}"',
    );
    expect(fallbackStep).toContain('if [ "$FAILURE_KIND" = "timeout" ]; then');
    // Slice the below-max arm so a transposition of the two bodies fails:
    // unordered containment keeps both texts present in the wrong arms.
    // Search for the else from the arm start so an unrelated earlier if/else
    // in this step cannot invert the slice.
    const belowMaxStart = fallbackStep.indexOf(
      'if [ "$TIMEOUT_MINUTES" -lt "$MAX_TIMEOUT_MINUTES" ]; then',
    );
    expect(belowMaxStart).toBeGreaterThan(-1);
    const belowMaxArm = fallbackStep.slice(
      belowMaxStart,
      fallbackStep.indexOf('else', belowMaxStart),
    );
    expect(belowMaxArm).toContain(
      '@qwen-code /review --timeout=${MAX_TIMEOUT_MINUTES}',
    );
    expect(belowMaxArm).not.toContain('This run already used the maximum');
    // Symmetric slice for the at-max arm: it is an adjacent body= assignment
    // in the same if-chain as the quota branch, the exact transposition class
    // the belowMaxArm slice catches.
    const atMaxStart = fallbackStep.indexOf('else', belowMaxStart);
    expect(atMaxStart).toBeGreaterThan(-1);
    // Line-anchored end: a bare indexOf('fi') stops at the first word
    // CONTAINING "fi" ("specified", "notification"), silently truncating the
    // arm and giving the not-toContain below a vacuous pass.
    const atMaxEnd = fallbackStep.slice(atMaxStart).search(/\n\s*fi\b/);
    expect(atMaxEnd).toBeGreaterThan(-1);
    const atMaxArm = fallbackStep.slice(atMaxStart, atMaxStart + atMaxEnd);
    expect(atMaxArm).toContain(
      'This run already used the maximum ${MAX_TIMEOUT_MINUTES} minute timeout.',
    );
    expect(atMaxArm).not.toContain('/review --timeout=');
    // The quota branch carries its own recovery advice; pin it to its arm.
    const quotaStart = fallbackStep.indexOf(
      'elif [ "$FAILURE_KIND" = "quota" ]; then',
    );
    expect(quotaStart).toBeGreaterThan(-1);
    const quotaArm = fallbackStep.slice(
      quotaStart,
      fallbackStep.indexOf('else', quotaStart),
    );
    expect(quotaArm).toContain(
      '**Qwen Code review paused — model quota exhausted.**',
    );
    // The branch CONDITION, not just both branch bodies: with both bodies
    // pinned as substrings, any comparison flip (-ge/-gt/-le) keeps both
    // strings present and ships the wrong recovery advice on every timeout.
    expect(fallbackStep).toContain(
      'if [ "$TIMEOUT_MINUTES" -lt "$MAX_TIMEOUT_MINUTES" ]; then',
    );
    expect(fallbackStep).toContain('**Qwen Code review timed out.**');
    // The comment must come AFTER all three arms: containment holds wherever
    // the line sits, so a move into one arm would silently drop the others.
    const genericBodyStart = fallbackStep.indexOf(
      '**Qwen Code review did not complete successfully.**',
    );
    expect(genericBodyStart).toBeGreaterThan(-1);
    const commentStart = fallbackStep.indexOf('gh pr comment "$PR_NUMBER"');
    expect(commentStart).toBeGreaterThan(genericBodyStart);
    // The wiring that delivers every body pinned above: pointing the command
    // at a different variable posts text none of these assertions protect.
    expect(fallbackStep).toContain('--body "$body"');
    expect(fallbackStep).not.toContain(
      '_Qwen Code review did not complete successfully:',
    );
  });

  it('skips stale automatic review runs before invoking qwen', () => {
    const runStep = step(reviewJob, 'Run review');
    const staleHeadStart = runStep.indexOf(
      'if [ "$EVENT_NAME" = "pull_request_target" ]; then',
    );
    // Without this, a reworded guard makes `indexOf` return -1 and the slice
    // below silently degrades instead of failing.
    expect(staleHeadStart).toBeGreaterThan(-1);
    const staleHeadCheck = runStep.slice(
      staleHeadStart,
      runStep.indexOf('PROMPT="/review ${REVIEW_URL}"'),
    );

    // Both context values arrive as step env so the run body carries no
    // `${{ }}` — see the expression-length test in
    // qwen-pr-review-workflow.test.js for why that is load-bearing.
    expect(runStep).toContain("EVENT_NAME: '${{ github.event_name }}'");
    expect(runStep).toContain(
      "EVENT_HEAD_SHA: '${{ github.event.pull_request.head.sha }}'",
    );
    expect(staleHeadCheck).toContain(
      'if [ "$CURRENT_HEAD_SHA" != "$EVENT_HEAD_SHA" ]; then',
    );
    expect(runStep).toContain(
      'PR_DATA="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state,headRefOid --jq \'[.state, .headRefOid] | @tsv\')"',
    );
    expect(runStep).toContain(
      'IFS=$\'\\t\' read -r PR_STATE CURRENT_HEAD_SHA <<< "$PR_DATA"',
    );
    expect(staleHeadCheck).toContain(
      'Skipping stale review run: event head ${EVENT_HEAD_SHA} is no longer current',
    );
    expect(staleHeadCheck).toContain('exit 0');
  });

  it('guards PR review publication against closed or stale PRs', () => {
    const runStep = step(reviewJob, 'Run review');
    const fallbackStep = step(reviewJob, 'Post fallback comment on failure');

    expect(runStep).toContain('guard_pr_write()');
    expect(runStep).toContain(
      'Blocked PR write: PR #${pr_number} is ${state}.',
    );
    expect(runStep).toContain(
      'Blocked PR write: PR #${pr_number} moved from ${expected_head} to ${current_head}.',
    );
    expect(runStep).toContain('repos/*/pulls/*/reviews');
    expect(runStep).toContain('repos/*/pulls/*/comments');
    expect(runStep).toContain('repos/*/issues/*/comments');
    expect(runStep).toContain('repos/*/issues/comments/*');
    expect(runStep).toContain('QWEN_CI_REVIEW_REPO="$REPO"');
    expect(runStep).toContain('QWEN_CI_REVIEW_PR_NUMBER="$PR_NUMBER"');
    expect(runStep).toContain(
      'QWEN_CI_REVIEW_EXPECTED_HEAD_SHA="$EXPECTED_HEAD_SHA"',
    );
    expect(runStep).toContain('echo "expected_head_sha=$EXPECTED_HEAD_SHA"');
    expect(fallbackStep).toContain('EXPECTED_HEAD_SHA:');
    expect(fallbackStep).toContain(
      'Skipping fallback comment: PR #${PR_NUMBER} is ${pr_state}.',
    );
    expect(fallbackStep).toContain(
      'Skipping fallback comment: PR #${PR_NUMBER} moved from ${EXPECTED_HEAD_SHA} to ${current_head}.',
    );
  });

  it('blocks wrapped gh review writes when the PR is closed or stale', () => {
    const runStep = step(reviewJob, 'Run review');
    const closedReview = runReviewGhWrapper(
      runStep,
      ['api', 'repos/owner/repo/pulls/123/reviews', '--input', 'review.json'],
      'CLOSED',
      'head-a',
    );
    expect(closedReview.status).toBe(90);
    expect(closedReview.stderr).toContain(
      'Blocked PR write: PR #123 is CLOSED',
    );
    expect(closedReview.ghLog).toBe('');

    const staleSummary = runReviewGhWrapper(
      runStep,
      [
        'api',
        'repos/owner/repo/issues/comments/456',
        '--method',
        'PATCH',
        '--input',
        'summary.json',
      ],
      'OPEN',
      'head-b',
    );
    expect(staleSummary.status).toBe(90);
    expect(staleSummary.stderr).toContain(
      'Blocked PR write: PR #123 moved from head-a to head-b',
    );
    expect(staleSummary.ghLog).toBe('');
  });

  it('lets a salvage-armed run post against its reviewed head after a move (#10110)', () => {
    const runStep = step(reviewJob, 'Run review');
    // The marker content must equal the head this run reviewed
    // (EXPECTED_HEAD_SHA): the supersede watcher pins it there, so a stale
    // marker left by another run on the reused runner can never match.
    const salvaged = runReviewGhWrapper(
      runStep,
      ['api', 'repos/owner/repo/pulls/123/reviews', '--input', 'review.json'],
      'OPEN',
      'head-b',
      'head-a',
      { salvageContent: 'head-a' },
    );
    expect(salvaged.status).toBe(0);
    expect(salvaged.stderr).toContain('PR write allowed (salvage)');
    expect(salvaged.ghLog).toContain(
      'api repos/owner/repo/pulls/123/reviews --input review.json',
    );

    // Wrong pin — a marker for some other head blocks exactly as before.
    const wrongPin = runReviewGhWrapper(
      runStep,
      ['api', 'repos/owner/repo/pulls/123/reviews', '--input', 'review.json'],
      'OPEN',
      'head-b',
      'head-a',
      { salvageContent: 'head-z' },
    );
    expect(wrongPin.status).toBe(90);
    expect(wrongPin.stderr).toContain(
      'Blocked PR write: PR #123 moved from head-a to head-b',
    );
    expect(wrongPin.ghLog).toBe('');

    // Salvage never overrides the OPEN check: a closed PR stays blocked.
    const closedSalvage = runReviewGhWrapper(
      runStep,
      ['api', 'repos/owner/repo/pulls/123/reviews', '--input', 'review.json'],
      'CLOSED',
      'head-b',
      'head-a',
      { salvageContent: 'head-a' },
    );
    expect(closedSalvage.status).toBe(90);
    expect(closedSalvage.stderr).toContain(
      'Blocked PR write: PR #123 is CLOSED',
    );
    expect(closedSalvage.ghLog).toBe('');
  });

  it.skipIf(!hasMkfifo)(
    'bounds the salvage marker read on the posting path (#10110)',
    () => {
      const runStep = step(reviewJob, 'Run review');
      // R8-10: the escape's marker read is one timeout-bounded, size-capped
      // open. A FIFO rename-swapped in at open time — or planted statically —
      // must fail CLOSED to the block inside the bound: an unbounded open
      // wedges the posting path forever, the attempt budget bleeds out, and
      // the salvage-armed cede then discards a finished review with no
      // failure signal at all.
      const wedged = runReviewGhWrapper(
        runStep,
        ['api', 'repos/owner/repo/pulls/123/reviews', '--input', 'review.json'],
        'OPEN',
        'head-b',
        'head-a',
        { salvageContent: 'head-a', swapSalvageOnRead: true },
      );
      expect(wedged.status).toBe(90);
      expect(wedged.stderr).toContain(
        'Blocked PR write: PR #123 moved from head-a to head-b',
      );
      expect(wedged.ghLog).toBe('');

      const fifo = runReviewGhWrapper(
        runStep,
        ['api', 'repos/owner/repo/pulls/123/reviews', '--input', 'review.json'],
        'OPEN',
        'head-b',
        'head-a',
        { salvageFifo: true },
      );
      expect(fifo.status).toBe(90);
      expect(fifo.stderr).toContain(
        'Blocked PR write: PR #123 moved from head-a to head-b',
      );
      expect(fifo.ghLog).toBe('');
    },
  );

  it('allows wrapped gh review writes when the PR is still current', () => {
    const runStep = step(reviewJob, 'Run review');
    const currentSummary = runReviewGhWrapper(
      runStep,
      [
        'api',
        'repos/owner/repo/issues/123/comments',
        '--method',
        'POST',
        '--input',
        'summary.json',
      ],
      'OPEN',
      'head-a',
    );

    expect(currentSummary.status).toBe(0);
    expect(currentSummary.ghLog).toContain(
      'api repos/owner/repo/issues/123/comments --method POST --input summary.json',
    );
  });

  // Whole-file `toContain` cannot tell which job a guard lives on. Slice the
  // resolve-pr job so these assertions fail if a future edit drops a guard
  // specifically from the credentialed conflict-resolution path. Bound the slice
  // at the next top-level job so a job added after resolve-pr can't leak its
  // strings in and mask a guard removed from resolve-pr itself. Match a line
  // indented exactly two spaces; `indexOf('\n  ')` would wrongly stop at the
  // first 4-space-indented line inside the job.
  const resolveJobStart = workflow.indexOf('\n  resolve-pr:');
  const nextJob = workflow.slice(resolveJobStart + 1).search(/\n {2}\S/);
  const resolveJob =
    nextJob === -1
      ? workflow.slice(resolveJobStart)
      : workflow.slice(resolveJobStart, resolveJobStart + 1 + nextJob);
  const reviewJob = job(workflow, 'review-pr');
  const delayAutomaticReviewJob = job(workflow, 'delay-automatic-review');
  const authorizeJob = job(workflow, 'authorize');
  const precheckJob = job(workflow, 'precheck-pr');

  it('keeps closed PR events from running precheck or authorize jobs', () => {
    expect(precheckJob).toContain("github.event.action != 'closed'");
    expect(authorizeJob).toContain("github.event.action != 'closed'");
  });

  it('keeps automatic review jobs cancellable by concurrency', () => {
    for (const lifecycleJob of [
      authorizeJob,
      delayAutomaticReviewJob,
      reviewJob,
    ]) {
      expect(lifecycleJob).toContain('!cancelled() &&');
      expect(lifecycleJob).not.toContain('\n      always() &&');
    }
  });

  it('does not require fork PR authors to have write permission for automatic review', () => {
    const authorizeStep = step(
      authorizeJob,
      'Check principal write permission',
    );

    expect(authorizeJob).toContain(
      "needs.precheck-pr.outputs.decision == 'allow_triage'",
    );
    expect(authorizeStep).toMatch(
      /if \[ "\$PR_ACTION" = "review_requested" \]; then\s+principal="\$SENDER"/,
    );
    const reviewRequestedStart = authorizeStep.indexOf(
      'if [ "$PR_ACTION" = "review_requested" ]; then',
    );
    expect(reviewRequestedStart).toBeGreaterThan(-1);
    const reviewRequestedBranch = authorizeStep.slice(
      reviewRequestedStart,
      authorizeStep.indexOf('else', reviewRequestedStart),
    );
    expect(reviewRequestedBranch).toContain('principal="$SENDER"');
    expect(reviewRequestedBranch).not.toContain(
      'echo "should_review=true" >> "$GITHUB_OUTPUT"',
    );
    expect(reviewRequestedBranch).not.toContain('exit 0');
    expect(authorizeStep).toContain('pull_request_target)');
    expect(authorizeStep).toContain(
      'Automatic PR review allowed for PR #${PR_NUMBER} after same-repo/precheck gate.',
    );
    expect(authorizeStep).toContain(
      'echo "should_review=true" >> "$GITHUB_OUTPUT"',
    );
    expect(authorizeStep).not.toContain('principal="$PR_AUTHOR"');
  });

  it('keeps the authorization and scope guards on resolve-pr', () => {
    // /resolve must require write+ permission before any credentialed push.
    expect(resolveJob).toContain(
      "needs.authorize.outputs.should_review == 'true'",
    );
    // Fork PRs are supported: the head is fetched through refs/pull/N/head and
    // the resolved branch is pushed back to the PR's head repository.
    expect(resolveJob).toContain('refs/pull/${PR_NUMBER}/head');
    expect(resolveJob).toContain('github.com/${HEAD_REPO}.git');
    // Out-of-scope edits (prompt-injection symptom) fail closed.
    expect(resolveJob).toContain(
      'Agent modified files outside the conflict set',
    );
    // The push only happens through the credentialed publish step, SHA-pinned:
    // the bare flag would allow any force-push regardless of the remote's current
    // state, defeating the concurrent-update guard.
    expect(resolveJob).toContain('--force-with-lease="refs/heads/');
    expect(resolveJob).toContain(':${HEAD_SHA}"');
  });

  it('fetches the PR head into a collision-free local ref', () => {
    expect(resolveJob).toContain(
      'head_fetch_ref="refs/remotes/origin/qwen-resolve/pr-${PR_NUMBER}/head"',
    );
    expect(resolveJob).toContain(
      '"+refs/pull/${PR_NUMBER}/head:${head_fetch_ref}"',
    );
    expect(resolveJob).not.toContain(
      '+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/${head_ref}',
    );
    expect(resolveJob).toContain('HEAD_FETCH_REF:');
    expect(resolveJob).toContain(
      'git diff --name-only -z --diff-filter=ACMRT "$HEAD_FETCH_REF" HEAD',
    );
  });

  it('keeps the verification-gate failure checks on resolve-pr', () => {
    // These guard against prompt-injection symptoms; a future edit that drops
    // any of them from the credentialed conflict-resolution path must fail here.
    expect(resolveJob).toContain(
      'Leftover conflict markers found after resolution',
    );
    expect(resolveJob).toContain('Branch still has merge conflicts with');
    expect(resolveJob).toContain('The top commit is a default merge commit');
    expect(resolveJob).toContain(
      'Branch unchanged and no no-action.md was written',
    );
    expect(resolveJob).toContain(
      'The conflict-resolution agent step did not succeed',
    );
    expect(resolveJob).toContain('address-summary.md is missing');
    expect(resolveJob).toContain('Unresolved index conflicts remain');
  });

  it('pins the core security controls on resolve-pr', () => {
    // Checkout must not persist GITHUB_TOKEN into .git/config.
    expect(resolveJob).toContain('persist-credentials: false');
    // The resolution check carries no writable GitHub token (defense in depth).
    expect(resolveJob).toContain("GITHUB_TOKEN: ''");
    // The agent runs sandboxed.
    expect(resolveJob).toContain('"sandbox": true');
    // Concurrent /resolve runs must not interleave on the credentialed push.
    expect(resolveJob).toContain('cancel-in-progress: false');
  });

  it('runs the agent without any GitHub credentials', () => {
    const agentStep = resolveJob.slice(
      resolveJob.indexOf("- name: 'Resolve conflicts'"),
      resolveJob.indexOf("- name: 'Resolution check'"),
    );
    expect(agentStep.length).toBeGreaterThan(0);
    expect(agentStep).not.toContain('GH_TOKEN');
    expect(agentStep).not.toContain('GITHUB_TOKEN');
    expect(agentStep).not.toContain('CI_BOT_PAT');
    expect(agentStep).not.toContain('CI_DEV_BOT_PAT');
  });

  it('supports dry-run and workflow_dispatch', () => {
    expect(workflow).toContain('github.event.inputs.dry_run');
    expect(workflow).toContain('in dry-run mode');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.event.inputs.command == 'resolve'");
  });

  it('classifies push failures so forks get an actionable comment', () => {
    // Resolving merges the base in, so the push carries the base's workflow-file
    // changes; a token without the `workflow` scope is rejected, and that gets its
    // own actionable reason. A 403 (maintainer-edits off / org-owned fork / PAT
    // lacking push) and a stale force-with-lease are reported differently too.
    expect(resolveJob).toContain("push_fail_reason='workflow_scope'");
    expect(resolveJob).toContain('grant that scope to the push bot');
    expect(resolveJob).toContain("push_fail_reason='permission'");
    expect(resolveJob).toContain("push_fail_reason='moved'");
    expect(resolveJob).toContain('Allow edits by maintainers');
  });
});
