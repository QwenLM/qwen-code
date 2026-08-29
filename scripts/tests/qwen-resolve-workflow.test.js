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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

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

function runReviewGhWrapper(
  runStep,
  args,
  prState,
  currentHead,
  expectedHead = 'head-a',
) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-review-gh-'));
  try {
    const wrapperPath = path.join(tempDir, 'gh');
    const realGhPath = path.join(tempDir, 'real-gh');
    const ghLogPath = path.join(tempDir, 'gh.log');
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

    const result = spawnSync(wrapperPath, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GH_LOG: ghLogPath,
        FAKE_HEAD_SHA: currentHead,
        FAKE_PR_STATE: prState,
        QWEN_CI_REAL_GH: realGhPath,
        QWEN_CI_REVIEW_EXPECTED_HEAD_SHA: expectedHead,
        QWEN_CI_REVIEW_PR_NUMBER: '123',
        QWEN_CI_REVIEW_REPO: 'owner/repo',
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

  it('keeps synchronize cancellation expression simple for workflow-level concurrency', () => {
    const concurrencyStart = workflow.indexOf('\nconcurrency:');
    const concurrency = workflow.slice(
      concurrencyStart,
      workflow.indexOf('\njobs:', concurrencyStart),
    );

    expect(concurrency).toContain(
      "cancel-in-progress: \"${{ github.event_name == 'pull_request_target' && (github.event.action == 'synchronize' || github.event.action == 'closed') }}\"",
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

// A /resolve request is lost after the agent succeeded whenever the push is
// declined, and before the agent even runs whenever a preflight refuses it.
// The suite below pins the recovery paths added for the largest of those
// losses (2026-06-25..08-27, 839 requests): the head moving during the run
// (17 resolutions lost), fork PRs the bot cannot push to (10 agent runs
// wasted), transient permission-API errors (silent denials), and the draft
// gate (182 skip comments on explicit requests).
describe('qwen resolve workflow: recovering requests that used to be lost', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/qwen-code-pr-review.yml'),
    'utf8',
  );
  const resolveJob = job(workflow, 'resolve-pr');
  const authorizeJob = job(workflow, 'authorize');
  const prepareStep = step(resolveJob, 'Prepare pull request branch');
  const reportStep = step(resolveJob, 'Report result');
  const authorizeStep = step(authorizeJob, 'Check principal write permission');

  // The replay functions, dedented out of the `run: |-` block so a real git
  // fixture can exercise them exactly as the runner will.
  function replayFunctions() {
    const start = reportStep.indexOf('replay_give_up() {');
    const end = reportStep.indexOf('\n          if [ "$OUTCOME" = "fixed" ]');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return reportStep.slice(start, end).replace(/^ {10}/gm, '');
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  function git(cwd, ...args) {
    const result = spawnSync('git', args, {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result.stdout.trim();
  }

  // Builds: a bare origin with `main` and refs/pull/1/head; a runner checkout
  // on branch qwen-resolve/pr-1 holding the agent's resolution of a.txt (the
  // conflicted file) merged on top of the ORIGINAL head; and a contributor
  // clone that can move the head. Returns the paths and the original head SHA.
  function makeFixture(resolveWith = 'edit') {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-resolve-replay-'));
    const origin = path.join(root, 'origin.git');
    const contributor = path.join(root, 'contributor');
    const runner = path.join(root, 'runner');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'init', '-q', '-b', 'main', contributor);
    writeFileSync(path.join(contributor, 'a.txt'), 'shared line\n');
    writeFileSync(path.join(contributor, 'b.txt'), 'b original\n');
    git(contributor, 'add', '.');
    git(contributor, 'commit', '-q', '-m', 'chore: seed');
    git(contributor, 'checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(contributor, 'a.txt'), 'feature side\n');
    git(contributor, 'commit', '-q', '-am', 'feat: feature side');
    const originalHead = git(contributor, 'rev-parse', 'HEAD');
    git(contributor, 'checkout', '-q', 'main');
    writeFileSync(path.join(contributor, 'a.txt'), 'main side\n');
    writeFileSync(path.join(contributor, 'c.txt'), 'c from main\n');
    git(contributor, 'add', '.');
    git(contributor, 'commit', '-q', '-m', 'feat: main side');
    git(contributor, 'remote', 'add', 'origin', origin);
    git(
      contributor,
      'push',
      '-q',
      'origin',
      'main',
      'feature:refs/pull/1/head',
    );

    git(root, 'clone', '-q', origin, runner);
    git(
      runner,
      'fetch',
      '-q',
      'origin',
      '+refs/pull/1/head:refs/remotes/origin/qwen-resolve/pr-1/head',
      '+refs/heads/main:refs/remotes/origin/main',
    );
    git(
      runner,
      'checkout',
      '-q',
      '-B',
      'qwen-resolve/pr-1',
      'refs/remotes/origin/qwen-resolve/pr-1/head',
    );
    // The agent's merge: a.txt conflicts, resolved to a line neither side had.
    spawnSync('git', ['merge', '--no-commit', 'origin/main'], {
      cwd: runner,
      env: gitEnv,
    });
    if (resolveWith === 'delete') {
      // Deleting the conflicted file IS the agent's resolution of it.
      git(runner, 'rm', '-q', '--', 'a.txt');
    } else {
      writeFileSync(path.join(runner, 'a.txt'), 'resolved by agent\n');
      git(runner, 'add', 'a.txt');
    }
    git(runner, 'commit', '-q', '-m', 'fix: resolve merge conflicts with main');
    const resolvedCommit = git(runner, 'rev-parse', 'HEAD');
    return { root, origin, contributor, runner, originalHead, resolvedCommit };
  }

  function moveHead(fixture, file, content) {
    git(fixture.contributor, 'checkout', '-q', 'feature');
    writeFileSync(path.join(fixture.contributor, file), content);
    git(fixture.contributor, 'add', file);
    git(
      fixture.contributor,
      'commit',
      '-q',
      '-m',
      `chore: move head (${file})`,
    );
    git(
      fixture.contributor,
      'push',
      '-q',
      'origin',
      'feature:refs/pull/1/head',
    );
    return git(fixture.contributor, 'rev-parse', 'HEAD');
  }

  function runReplay(fixture) {
    // The production step has already scrubbed the workspace before the
    // replay runs (#10428): no .git/config — so no `origin` remote and no
    // user.name/email — and no global config. Reproduce that state so the
    // replay must carry its own identity and fetch by URL.
    const replayEnv = { ...gitEnv };
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]) {
      delete replayEnv[key];
    }
    const script = [
      'set -euo pipefail',
      'rm -f .git/config',
      replayFunctions(),
      'replayed_on=""',
      'if replay_on_moved_head; then rc=0; else rc=$?; fi',
      'echo "rc=$rc"',
      'echo "HEAD_SHA=$HEAD_SHA"',
      'echo "replayed_on=$replayed_on"',
      'echo "head=$(git rev-parse HEAD)"',
      'echo "branch=$(git rev-parse --abbrev-ref HEAD)"',
      'echo "status=$(git status --porcelain | tr "\\n" ";")"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      cwd: fixture.runner,
      env: {
        ...replayEnv,
        PR_NUMBER: '1',
        HEAD_SHA: fixture.originalHead,
        BASE_REF: 'main',
        REPO: 'QwenLM/qwen-code',
        // The replay fetches by URL (the scrub removes the `origin` remote
        // with .git/config); point it at the fixture's bare repository.
        RESOLVE_ORIGIN_URL: fixture.origin,
      },
      encoding: 'utf8',
    });
    const out = Object.fromEntries(
      result.stdout
        .split('\n')
        .filter((line) =>
          /^(rc|HEAD_SHA|replayed_on|head|branch|status)=/.test(line),
        )
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    return { ...out, stdout: result.stdout, stderr: result.stderr };
  }

  it('replays the resolution when the head moved in files the conflict did not touch', () => {
    const fixture = makeFixture();
    try {
      const newHead = moveHead(
        fixture,
        'b.txt',
        'b changed after the agent started\n',
      );
      const out = runReplay(fixture);
      expect(out.rc, out.stdout + out.stderr).toBe('0');
      // The lease for the second push is taken on the NEW head.
      expect(out.HEAD_SHA).toBe(newHead);
      expect(out.replayed_on).toBe(newHead);
      expect(out.status).toBe('');
      // The replayed commit sits on the new head, merges the base, keeps the
      // agent's resolution and the contributor's new change, and reuses the
      // agent's commit message (CI rejects git's default merge message).
      const parents = git(
        fixture.runner,
        'log',
        '-1',
        '--format=%P',
        out.head,
      ).split(' ');
      expect(parents).toContain(newHead);
      expect(parents).toContain(
        git(fixture.runner, 'rev-parse', 'origin/main'),
      );
      expect(readFileSync(path.join(fixture.runner, 'a.txt'), 'utf8')).toBe(
        'resolved by agent\n',
      );
      expect(readFileSync(path.join(fixture.runner, 'b.txt'), 'utf8')).toBe(
        'b changed after the agent started\n',
      );
      expect(readFileSync(path.join(fixture.runner, 'c.txt'), 'utf8')).toBe(
        'c from main\n',
      );
      expect(git(fixture.runner, 'log', '-1', '--format=%s', out.head)).toBe(
        'fix: resolve merge conflicts with main',
      );
      // The scrub removed user.name/email with .git/config; the replay must
      // bring the bot identity itself (the author is reused from the agent's
      // commit by -C).
      expect(
        git(fixture.runner, 'log', '-1', '--format=%cn <%ce>', out.head),
      ).toBe('qwen-code-dev-bot <qwen-code-dev-bot@users.noreply.github.com>');
      // Only base-changed files differ from the new head: the scope guard holds.
      expect(
        git(fixture.runner, 'diff', '--name-only', newHead, out.head)
          .split('\n')
          .sort(),
      ).toEqual(['a.txt', 'c.txt']);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('gives up, and restores the original resolution, when the new head touched a conflicted file', () => {
    const fixture = makeFixture();
    try {
      moveHead(fixture, 'a.txt', 'feature side, edited again\n');
      const out = runReplay(fixture);
      expect(out.rc, out.stdout + out.stderr).toBe('1');
      expect(out.stdout).toContain(
        'Replay gave up: a.txt still conflicts and the new head changed it',
      );
      // Nothing was taken from the agent's merge for a file the contributor
      // rewrote, the lease SHA is untouched, and the checkout is back on the
      // original resolution with a clean tree — the artifact and the "moved"
      // comment describe exactly what exists.
      expect(out.HEAD_SHA).toBe(fixture.originalHead);
      expect(out.replayed_on).toBe('');
      expect(out.branch).toBe('qwen-resolve/pr-1');
      expect(out.head).toBe(fixture.resolvedCommit);
      expect(out.status).toBe('');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('gives up when the head did not move at all (the push failed for another reason)', () => {
    const fixture = makeFixture();
    try {
      const out = runReplay(fixture);
      expect(out.rc, out.stdout + out.stderr).toBe('1');
      expect(out.stdout).toContain('the push was declined for another reason');
      expect(out.head).toBe(fixture.resolvedCommit);
      expect(out.branch).toBe('qwen-resolve/pr-1');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('wires the replay into the push path with a lease on the new head, and never re-runs the agent', () => {
    expect(reportStep).toContain(
      '[ "$push_fail_reason" = "moved" ] && replay_on_moved_head && push_resolution',
    );
    // The lease still names ${HEAD_SHA}; the replay moves that variable to the
    // new head instead of pushing with a bare --force.
    expect(reportStep).toContain(
      '--force-with-lease="refs/heads/${HEAD_REF}:${HEAD_SHA}"',
    );
    expect(reportStep).toContain('HEAD_SHA="$new_sha"');
    expect(reportStep).not.toContain('--force ');
    // The replay re-applies the structural checks of 'Resolution check'.
    const replay = replayFunctions();
    expect(replay).toContain("grep -InE -e '^(<<<<<<<|>>>>>>>) '");
    expect(replay).toContain(
      'git merge-tree --write-tree "origin/${BASE_REF}" HEAD',
    );
    expect(replay).toContain('comm -23 <(printf');
    expect(replay).not.toContain('qwen-code-action');
    // The credentialed steps remove the workspace .git/config — and with it
    // the `origin` remote — before they run, so the replay must fetch by URL.
    expect(replay).toContain(
      'git fetch "${RESOLVE_ORIGIN_URL:-https://github.com/${REPO}.git}"',
    );
    expect(replay).not.toContain('git fetch origin');
    // And the comment says a replay happened.
    expect(reportStep).toContain('the resolution was replayed on top of it');
  });

  it('defines every uppercase variable the resolve-pr run blocks expand', () => {
    // The steps run under `set -u`; a ${NAME} the env block does not define
    // aborts the step at first use. The replay was shipped once with BASE_REF
    // missing from 'Report result' — the fixture test injected it, so nothing
    // noticed. Cover every run block of the job, not just that one.
    const jobEnv = new Set(
      [...resolveJob.matchAll(/^ {6}([A-Z][A-Z0-9_]*): /gm)].map((m) => m[1]),
    );
    const builtins = new Set([
      'GITHUB_OUTPUT',
      'GITHUB_REPOSITORY',
      'GITHUB_STEP_SUMMARY',
      'RUNNER_TEMP',
      'HOME',
      'PATH',
    ]);
    const stepBlocks = resolveJob.split(/\n {6}- name: /).slice(1);
    for (const block of stepBlocks) {
      if (!/\n {8}run: \|-?\n/.test(block)) {
        continue;
      }
      const name = block.slice(0, block.indexOf('\n'));
      const stepEnv = new Set(
        [...block.matchAll(/^ {10}([A-Z][A-Z0-9_]*): /gm)].map((m) => m[1]),
      );
      const run = block.slice(block.search(/\n {8}run: \|-?\n/));
      const assigned = new Set(
        [...run.matchAll(/(?:^|[\s;{(])([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
      );
      const referenced = new Set(
        [...run.matchAll(/\$\{?([A-Z][A-Z0-9_]+)\b/g)]
          .map((m) => m[1])
          .filter((v) => !v.startsWith('GITHUB_')),
      );
      const missing = [...referenced].filter(
        (v) =>
          !jobEnv.has(v) &&
          !stepEnv.has(v) &&
          !assigned.has(v) &&
          !builtins.has(v),
      );
      expect(
        missing,
        `step ${name} expands undefined: ${missing.join(', ')}`,
      ).toEqual([]);
    }
    // And the one that shipped missing is now there.
    expect(step(resolveJob, 'Report result')).toContain(
      "BASE_REF: '${{ steps.prepare.outputs.base_ref }}'",
    );
  });

  it('refuses fork PRs the bot cannot push to before spending an agent run', () => {
    expect(prepareStep).toContain('maintainerCanModify');
    expect(prepareStep).toContain(
      '[ "$head_repo" != "$REPO" ] && [ "$maintainer_can_modify" != "true" ]',
    );
    expect(prepareStep).toContain('**Allow edits by maintainers** off');
    // Same-repo PRs report maintainerCanModify=false too; the fork check must
    // be conjoined with the head-repo comparison or every in-repo PR is refused.
    expect(prepareStep).not.toMatch(
      /\n\s+if \[ "\$maintainer_can_modify" != "true" \]; then/,
    );
  });

  it('no longer refuses draft PRs', () => {
    // /resolve is an explicit request by a writer; a draft with conflicts is
    // where resolving is cheapest. The automatic review lane keeps its gate.
    expect(prepareStep).not.toContain('is draft.');
    expect(prepareStep).not.toContain('isDraft');
    expect(job(workflow, 'delay-automatic-review')).toContain('is draft.');
  });

  it('retries a transient permission-API error before denying, and still fails closed', () => {
    expect(authorizeJob).toContain(
      'failed transiently (attempt ${attempt} of 3)',
    );
    expect(authorizeJob).toContain('No server is currently available');
    // The strings above stay put if the loop itself regresses: the bound,
    // the backoff, and the retry branch are pinned by the behavioural tests
    // below, and their YAML anchors here.
    expect(authorizeJob).toContain('[ "$attempt" -lt 3 ]');
    expect(authorizeJob).toContain('sleep $((attempt * 5))');
    // After the retries the original fail-closed denial is unchanged.
    expect(authorizeJob).toContain(
      '::error::Permission API call failed for ${principal}: ${api_error}',
    );
    expect(authorizeJob).toContain(
      'echo "should_review=false" >> "$GITHUB_OUTPUT"',
    );
  });

  // --- classify_push_failure: order pin + behaviour against real push logs ---

  it('tests the lease-decline signature before the permission patterns', () => {
    // git echoes the destination branch into the push log; the permission
    // patterns are substrings of plausible branch names, the moved patterns
    // are server phrases a branch name cannot contain. Order is the guard.
    const scope = reportStep.indexOf("push_fail_reason='workflow_scope'");
    const moved = reportStep.indexOf("push_fail_reason='moved'");
    const permission = reportStep.indexOf("push_fail_reason='permission'");
    expect(scope).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(moved);
    expect(moved).toBeLessThan(permission);
  });

  function classifyFunction() {
    const start = reportStep.indexOf('classify_push_failure() {');
    const endMarker = '\n          }';
    const end = reportStep.indexOf(endMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return reportStep
      .slice(start, end + endMarker.length)
      .replace(/^ {10}/gm, '');
  }

  function classifyLog(lines) {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-classify-'));
    try {
      const pushLog = path.join(dir, 'push.log');
      writeFileSync(pushLog, `${lines.join('\n')}\n`);
      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -euo pipefail',
            classifyFunction(),
            'classify_push_failure',
            'printf "reason=%s\\n" "$push_fail_reason"',
          ].join('\n'),
        ],
        { encoding: 'utf8', env: { ...process.env, push_log: pushLog } },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout.match(/^reason=(.*)$/m)?.[1];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const staleInfoLog = (branch) => [
    'To github.com:contributor/repo.git',
    ` ! [remote rejected] HEAD -> ${branch} (stale info)`,
    "error: failed to push some refs to 'github.com/contributor/repo.git'",
  ];

  it('classifies a moved head by its lease decline even when the branch name echoes a permission substring', () => {
    expect(classifyLog(staleInfoLog('feature'))).toBe('moved');
    expect(classifyLog(staleInfoLog('fix/permission-prompt'))).toBe('moved');
    expect(classifyLog(staleInfoLog('fix-403-error'))).toBe('moved');
    // Genuine access problems still classify as permission, the workflow-scope
    // arm keeps its priority over both, and unknown failures stay 'other'.
    expect(
      classifyLog([
        "fatal: unable to access 'https://github.com/contributor/repo.git/': The requested URL returned error: 403",
      ]),
    ).toBe('permission');
    expect(
      classifyLog([
        'remote: refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope',
      ]),
    ).toBe('workflow_scope');
    expect(classifyLog(['error: something else entirely'])).toBe('other');
  });

  it('re-classifies from the current push log when the replay push fails for a new reason', () => {
    // After a failed replay push, classify_push_failure runs a second time;
    // the reported reason must come from the second push's log, not the stale
    // 'moved' from the first.
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-classify-'));
    try {
      const pushLog = path.join(dir, 'push.log');
      writeFileSync(pushLog, `${staleInfoLog('feature').join('\n')}\n`);
      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -euo pipefail',
            classifyFunction(),
            'classify_push_failure',
            'printf "first=%s\\n" "$push_fail_reason"',
            'printf "%s\\n" "$SECOND_LOG" > "$push_log"',
            'classify_push_failure',
            'printf "second=%s\\n" "$push_fail_reason"',
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            push_log: pushLog,
            SECOND_LOG:
              "fatal: unable to access 'https://github.com/contributor/repo.git/': The requested URL returned error: 403",
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('first=moved');
      expect(result.stdout).toContain('second=permission');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says in the replay comment what the run artifact does and does not describe', () => {
    // The artifact's pr.diff is computed before the replay runs; the pushed
    // tree is the replay. The comment must say so, and must not claim files
    // were taken from the agent's merge when the replay merged clean.
    const armStart = reportStep.indexOf('elif [ -n "$replayed_on" ]; then');
    expect(armStart).toBeGreaterThan(-1);
    const arm = reportStep.slice(
      armStart,
      reportStep.indexOf('\n                else', armStart),
    );
    expect(arm).toContain('the resolution was replayed on top of it');
    expect(arm).toContain(
      'files still conflicting that the new commits did not touch',
    );
    expect(arm).toContain(
      'describes the original resolution it was replayed from',
    );
  });

  // --- replay fixtures: the empty-merge give-up and deletion resolutions ---

  // The contributor merges the base into their PR branch while the agent
  // runs; the replay's re-merge of the base then changes nothing, so the
  // lane must give up cleanly instead of committing an unchanged tree.
  function mergeMainIntoHead(fixture) {
    git(fixture.contributor, 'checkout', '-q', 'feature');
    const merge = spawnSync('git', ['merge', '--no-edit', 'main'], {
      cwd: fixture.contributor,
      env: gitEnv,
      encoding: 'utf8',
    });
    // a.txt still conflicts between feature and main; the contributor keeps
    // their side and completes the merge themselves.
    expect(merge.status).not.toBe(0);
    writeFileSync(
      path.join(fixture.contributor, 'a.txt'),
      'feature side, merged by the contributor\n',
    );
    git(fixture.contributor, 'add', 'a.txt');
    git(fixture.contributor, 'commit', '-q', '--no-edit');
    git(
      fixture.contributor,
      'push',
      '-q',
      'origin',
      'feature:refs/pull/1/head',
    );
    return git(fixture.contributor, 'rev-parse', 'HEAD');
  }

  it('gives up cleanly when the new head already merged the base itself', () => {
    const fixture = makeFixture();
    try {
      const newHead = mergeMainIntoHead(fixture);
      expect(newHead).not.toBe(fixture.originalHead);
      const out = runReplay(fixture);
      expect(out.rc, out.stdout + out.stderr).toBe('1');
      expect(out.stdout).toContain('changes nothing');
      expect(out.HEAD_SHA).toBe(fixture.originalHead);
      expect(out.replayed_on).toBe('');
      expect(out.branch).toBe('qwen-resolve/pr-1');
      expect(out.head).toBe(fixture.resolvedCommit);
      expect(out.status).toBe('');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('replays a resolution that deleted the conflicted file', () => {
    const fixture = makeFixture('delete');
    try {
      const newHead = moveHead(
        fixture,
        'b.txt',
        'b changed after the agent started\n',
      );
      const out = runReplay(fixture);
      expect(out.rc, out.stdout + out.stderr).toBe('0');
      expect(out.HEAD_SHA).toBe(newHead);
      expect(out.replayed_on).toBe(newHead);
      // The agent's version of a.txt IS its deletion: the pushed tree must
      // not have the file back, and the scope guard still holds.
      expect(existsSync(path.join(fixture.runner, 'a.txt'))).toBe(false);
      expect(
        git(fixture.runner, 'ls-tree', '--name-only', out.head),
      ).not.toContain('a.txt');
      expect(
        git(fixture.runner, 'diff', '--name-only', newHead, out.head)
          .split('\n')
          .sort(),
      ).toEqual(['a.txt', 'c.txt']);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  // --- authorize retry loop: behaviour against a scripted gh ---

  function authorizeRetryBlock() {
    const start = authorizeStep.indexOf('api_error_file="$(mktemp)"');
    const endMarker = '\n          esac';
    const end = authorizeStep.indexOf(endMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return authorizeStep
      .slice(start, end + endMarker.length)
      .replace(/^ {10}/gm, '');
  }

  function runAuthorizeRetry(plan) {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-authorize-retry-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      mkdirSync(binDir);
      const planFile = path.join(tempDir, 'plan.txt');
      const callLog = path.join(tempDir, 'calls.log');
      const sleepLog = path.join(tempDir, 'sleeps.log');
      const outputFile = path.join(tempDir, 'output');
      const summaryFile = path.join(tempDir, 'summary');
      writeFileSync(planFile, `${plan.join('\n')}\n`);
      writeFileSync(callLog, '');
      writeFileSync(sleepLog, '');
      writeFileSync(outputFile, '');
      writeFileSync(summaryFile, '');
      writeFileSync(
        path.join(binDir, 'gh'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'printf "%s\\n" "$*" >> "$AUTHORIZE_CALL_LOG"',
          'n="$(cat "$AUTHORIZE_CALL_COUNT" 2>/dev/null || echo 0)"',
          'n=$((n + 1))',
          'printf "%s\\n" "$n" > "$AUTHORIZE_CALL_COUNT"',
          'line="$(sed -n "${n}p" "$AUTHORIZE_PLAN_FILE")"',
          'case "$line" in',
          '  ok:*) printf "%s\\n" "${line#ok:}" ;;',
          '  fail:*) printf "%s\\n" "${line#fail:}" >&2; exit 1 ;;',
          'esac',
        ].join('\n'),
      );
      chmodSync(path.join(binDir, 'gh'), 0o755);
      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -euo pipefail',
            'sleep() { printf "%s\\n" "$1" >> "$AUTHORIZE_SLEEP_LOG"; }',
            'principal=commenter',
            'GITHUB_REPOSITORY=owner/repo',
            authorizeRetryBlock(),
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            AUTHORIZE_PLAN_FILE: planFile,
            AUTHORIZE_CALL_COUNT: path.join(tempDir, 'count'),
            AUTHORIZE_CALL_LOG: callLog,
            AUTHORIZE_SLEEP_LOG: sleepLog,
            GITHUB_OUTPUT: outputFile,
            GITHUB_STEP_SUMMARY: summaryFile,
          },
        },
      );
      return {
        ...result,
        output: readFileSync(outputFile, 'utf8'),
        summary: readFileSync(summaryFile, 'utf8'),
        calls: readFileSync(callLog, 'utf8').split('\n').filter(Boolean),
        sleeps: readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean),
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const TRANSIENT_503 = 'fail:HTTP 503: No server is currently available';

  it('retries a transient permission-API error twice, then allows the writer', () => {
    const out = runAuthorizeRetry([TRANSIENT_503, TRANSIENT_503, 'ok:write']);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.output).toContain('should_review=true');
    expect(out.calls).toHaveLength(3);
    for (const call of out.calls) {
      expect(call).toBe(
        'api repos/owner/repo/collaborators/commenter/permission --jq .permission',
      );
    }
    expect(out.sleeps).toEqual(['5', '10']);
    expect(out.stdout).toContain('failed transiently (attempt 1 of 3)');
    expect(out.stdout).toContain('failed transiently (attempt 2 of 3)');
  });

  it('denies after three transient failures — fail closed', () => {
    const out = runAuthorizeRetry([
      TRANSIENT_503,
      TRANSIENT_503,
      TRANSIENT_503,
    ]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.output).toContain('should_review=false');
    expect(out.output).not.toContain('should_review=true');
    expect(out.calls).toHaveLength(3);
    expect(out.stdout).toContain(
      '::error::Permission API call failed for commenter',
    );
    expect(out.summary).toContain(
      'Failed to check permission for commenter (API error:',
    );
  });

  it('denies a non-transient permission-API error on the first attempt', () => {
    const out = runAuthorizeRetry(['fail:HTTP 404: Not Found']);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.output).toContain('should_review=false');
    expect(out.output).not.toContain('should_review=true');
    expect(out.calls).toHaveLength(1);
    expect(out.sleeps).toEqual([]);
    expect(out.summary).toContain(
      'Failed to check permission for commenter (API error:',
    );
  });
});
