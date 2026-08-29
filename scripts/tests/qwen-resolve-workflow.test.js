/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  existsSync,
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
    // The agent runs WITHOUT the container sandbox — measured, not assumed:
    // the first day `sandbox: true` took effect (#9252, 2026-08-16) /resolve
    // went from 84% pushed to 0 of 81, dying on a missing versioned image or
    // hanging to the job timeout. Containment is the no-token agent, the scope
    // guard and the ephemeral runner. Flipping this back needs a dry-run that
    // shows the agent finishing inside the container.
    expect(resolveJob).toContain('"sandbox": false');
    expect(resolveJob).not.toContain('"sandbox": true');
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

  it('hardens the post-agent steps against state the agent can plant', () => {
    // The agent step runs --yolo without a sandbox BEFORE these steps in the
    // same job: anything it appends to $GITHUB_ENV reaches every later step,
    // and it writes the workspace. 'Resolution check' must not be falsifiable
    // by planted shims or config, and the credentialed push in 'Report result'
    // must not inherit an executable or routable channel to the token.
    const verifyStep = step(resolveJob, 'Resolution check');
    const reportStep = step(resolveJob, 'Report result');
    const showStep = step(resolveJob, 'Show run artifacts');

    for (const postAgentStep of [verifyStep, reportStep, showStep]) {
      // BASH_ENV and LD_* execute at process startup, before any body line
      // runs — pin them empty at the step boundary, not merely unset in the
      // body.
      expect(postAgentStep).toContain("BASH_ENV: ''");
      expect(postAgentStep).toContain("LD_PRELOAD: ''");
      expect(postAgentStep).toContain("LD_AUDIT: ''");
      expect(postAgentStep).toContain("LD_LIBRARY_PATH: ''");
      // A planted PATH shim must not resolve git for the guard or the push,
      // and a planted PATH prepend must not stand in for the step shell.
      expect(postAgentStep).toContain('PATH=/usr/bin:/bin');
      expect(postAgentStep).toContain(
        "shell: '/bin/bash --noprofile --norc -eo pipefail {0}'",
      );
      // Host and global config are agent-reachable runner surfaces (url
      // rewrites redirect the token URL); GIT_CONFIG_COUNT injects config
      // through env. None of it may reach the git calls.
      expect(postAgentStep).toContain('export GIT_CONFIG_SYSTEM=/dev/null');
      expect(postAgentStep).toContain('export GIT_CONFIG_GLOBAL=/dev/null');
      expect(postAgentStep).toContain('export GIT_CONFIG_COUNT=0');
      // GIT_CONFIG_PARAMETERS injects config that survives GIT_CONFIG_COUNT=0
      // and the /dev/null scopes; GIT_EXTERNAL_DIFF and GIT_EXEC_PATH are
      // exec channels a content diff can hit. All three steps must drop the
      // whole list — the comment claims a 'same scrub', so pin it.
      expect(postAgentStep).toContain('unset GIT_CONFIG_PARAMETERS');
      // The scrub must execute BEFORE each step's first git/gh use —
      // relocating it below them re-exposes the checks and the push to
      // planted state, the exact regression this PR exists to stop.
      expect(postAgentStep.indexOf('PATH=/usr/bin:/bin')).toBeGreaterThan(-1);
    }
    expect(verifyStep.indexOf('PATH=/usr/bin:/bin')).toBeLessThan(
      verifyStep.indexOf('git ls-files -u'),
    );
    expect(reportStep.indexOf('PATH=/usr/bin:/bin')).toBeLessThan(
      reportStep.indexOf('push --no-verify'),
    );
    expect(reportStep.indexOf('PATH=/usr/bin:/bin')).toBeLessThan(
      reportStep.indexOf('gh pr comment'),
    );

    for (const postAgentStep of [verifyStep, reportStep]) {
      // The LOCAL .git/config is the highest-precedence scope and the agent
      // writes the workspace — hooks, filters, includes and url rewrites
      // planted there survive GIT_CONFIG_GLOBAL=/dev/null, so it is removed.
      expect(postAgentStep).toContain('rm -f .git/config');
      // A gitfile-replaced .git (`gitdir: <path>`) makes that rm a no-op and
      // lets a url.*.insteadOf rewrite the push URL with the token in the
      // request path — refuse it before any check and before the push.
      expect(postAgentStep).toContain('[ ! -d .git ]');
    }
    expect(verifyStep.indexOf('[ ! -d .git ]')).toBeLessThan(
      verifyStep.indexOf('git ls-files -u'),
    );
    expect(reportStep.indexOf('[ ! -d .git ]')).toBeLessThan(
      reportStep.indexOf('push --no-verify'),
    );

    // The credentialed push itself: hookless and verify-less, so a planted
    // pre-push hook never receives the token URL.
    expect(reportStep).toContain(
      'git -c core.hooksPath=/dev/null push --no-verify',
    );
    // Proxy and gh-host vars could route the push or the PAT comment to a
    // listener; they must be dropped from the inherited environment.
    expect(reportStep).toContain('HTTP_PROXY HTTPS_PROXY');
    expect(reportStep).toContain('GH_HOST GH_ENTERPRISE_TOKEN GH_CONFIG_DIR');
  });

  it('pins the CLI version and bounds the agent step', () => {
    const agentStep = resolveJob.slice(
      resolveJob.indexOf("- name: 'Resolve conflicts'"),
      resolveJob.indexOf("- name: 'Resolution check'"),
    );
    // `latest` ties every run to the npm release pipeline of the moment: the
    // 2026-08-15 dist-tag pointed at an unresolvable 0.21.12 and 14 runs died
    // on `npm error notarget` before the agent started.
    const installStep = step(resolveJob, 'Install Qwen CLI');
    expect(installStep).toMatch(/QWEN_CLI_VERSION: '\d+\.\d+\.\d+'/);
    expect(installStep).not.toContain("QWEN_CLI_VERSION: 'latest'");
    expect(installStep).toContain('@qwen-code/qwen-code@${QWEN_CLI_VERSION}');
    // Direct invocation, not the action: the action runs the CLI with the
    // runner's real $GITHUB_ENV/$GITHUB_PATH, which the scrub in the later
    // steps cannot fully undo (see 'hardens the post-agent steps').
    expect(agentStep).not.toContain('qwen-code-action');
    expect(agentStep).toContain('GITHUB_ENV="$decoy_dir/github-env"');
    expect(agentStep).toContain('GITHUB_PATH="$decoy_dir/github-path"');
    expect(agentStep).toContain('::stop-commands::');
    // A hung agent must end inside the script (GNU timeout), not by the
    // runner's timeout-minutes killing the process tree — only the
    // script-internal timeout reaches the ::stop-commands:: resume and the
    // command-file truncation (mirrors 'Run review'). The budget stays under
    // the step timeout, which remains the outer backstop.
    const timeoutCmd = agentStep.match(/timeout --kill-after=10s (\d+)s qwen/);
    expect(timeoutCmd).not.toBeNull();
    // The failure_kind contract depends on the exit code surviving:
    // swallowing it (`exit 0`, a trailing `|| true`) would let a crashed or
    // turn-capped agent report success and misroute the comment.
    expect(agentStep).toContain('status=$?');
    expect(agentStep).toMatch(/exit "\$status"\s*$/);
    // The decoys only mask the invocation's env; the real runner command
    // files stay agent-discoverable and are truncated on every exit path.
    for (const file of [
      'GITHUB_ENV',
      'GITHUB_PATH',
      'GITHUB_OUTPUT',
      'GITHUB_STEP_SUMMARY',
    ]) {
      expect(agentStep).toContain(`: > "\${${file}:?}" || true`);
    }
    expect(agentStep.indexOf('status=$?')).toBeLessThan(
      agentStep.indexOf(': > "${GITHUB_ENV:?}"'),
    );
    // A hung agent must not bill the whole 120-minute job; the step timeout
    // and the number quoted in the failure comment must agree.
    const stepTimeout = agentStep.match(/^\s+timeout-minutes: (\d+)$/m);
    expect(stepTimeout).not.toBeNull();
    const reportStep = resolveJob.slice(
      resolveJob.indexOf("- name: 'Report result'"),
    );
    expect(reportStep).toContain(`AGENT_TIMEOUT_MINUTES: '${stepTimeout[1]}'`);
    expect(Number(timeoutCmd[1])).toBeLessThan(Number(stepTimeout[1]) * 60);
    // Read the ceiling instead of duplicating it as a literal: if the job's
    // timeout-minutes drops to or below the step's, the job-level timeout
    // cancels the whole job on a hung agent — the always()-gated 'Resolution
    // check' and 'Report result' never start, so the failure posts neither
    // failure_kind=infra nor a "not a verdict" comment.
    const jobTimeout = resolveJob.match(/^ {4}timeout-minutes: (\d+)$/m);
    expect(jobTimeout).not.toBeNull();
    expect(Number(stepTimeout[1])).toBeLessThan(Number(jobTimeout[1]));
  });

  it('reports an agent that never ran as an infrastructure failure, not a verdict', () => {
    // outcome != success on the agent step means no resolution was attempted
    // (install/model/infra error, step timeout, cancellation). The comment
    // must say so and must not invite a re-run, which repeats the failure.
    const verifyStep = step(resolveJob, 'Resolution check');
    const reportStep = step(resolveJob, 'Report result');
    expect(reportStep).toContain(
      "FAILURE_KIND: '${{ steps.verify.outputs.failure_kind }}'",
    );
    expect(reportStep).toContain(
      "RESOLVE_OUTCOME: '${{ steps.resolve_conflicts.outcome }}'",
    );

    // The failure_kind=infra write is pinned to the never-ran block of
    // 'Resolution check' — moving it into the failure.md branch is the exact
    // regression this branch exists to stop (an infrastructure failure would
    // then post the generic verdict wording and invite re-runs).
    const neverRanStart = verifyStep.indexOf(
      'if [ "$RESOLVE_OUTCOME" != "success" ]; then',
    );
    expect(neverRanStart).toBeGreaterThan(-1);
    const neverRanArm = verifyStep.slice(
      neverRanStart,
      verifyStep.indexOf('exit 1', neverRanStart),
    );
    expect(neverRanArm).toContain(
      'echo "failure_kind=infra" >> "$GITHUB_OUTPUT"',
    );
    const failureMdStart = verifyStep.indexOf(
      'if [ -s "${WORKDIR}/failure.md" ]; then',
    );
    expect(failureMdStart).toBeGreaterThan(-1);
    const failureMdArm = verifyStep.slice(
      failureMdStart,
      verifyStep.indexOf('exit 1', failureMdStart),
    );
    expect(failureMdArm).not.toContain('failure_kind=infra');

    // Pin the branch CONDITION literal, then slice the two arms of the `*)`
    // case so a transposition of the bodies fails — unordered toContain kept
    // both texts present in either arm.
    const infraCond = 'if [ "$FAILURE_KIND" = "infra" ]; then';
    const infraStart = reportStep.indexOf(infraCond);
    expect(infraStart).toBeGreaterThan(-1);
    const infraArm = reportStep.slice(
      infraStart,
      reportStep.indexOf('else', infraStart),
    );
    expect(infraArm).toContain(
      'Qwen Code could not run conflict resolution on this PR',
    );
    expect(infraArm).toContain('This is not a verdict on the conflict');
    // The timeout rides as the env interpolation: hardcoding the number in
    // the message lets the pair drift when the step timeout changes.
    expect(infraArm).toContain('${AGENT_TIMEOUT_MINUTES}-minute timeout');
    expect(infraArm).not.toContain('Re-run /resolve');
    expect(infraArm).not.toContain(
      'Qwen Code attempted to resolve merge conflicts',
    );
    const elseStart = reportStep.indexOf('else', infraStart);
    expect(elseStart).toBeGreaterThan(-1);
    // Line-anchored end on the `*)` case terminator: the else arm nests its
    // own if/fi (the file-append loop), so a bare fi search truncates early.
    const elseEnd = reportStep.slice(elseStart).search(/\n\s*;;/);
    expect(elseEnd).toBeGreaterThan(-1);
    const elseArm = reportStep.slice(elseStart, elseStart + elseEnd);
    // Symmetric pin: the generic wording lives in the else arm only.
    expect(elseArm).toContain(
      'Qwen Code attempted to resolve merge conflicts but the run did not complete successfully.',
    );
    expect(elseArm).toContain('Check the [workflow run](');
    expect(elseArm).not.toContain('could not run conflict resolution');
    expect(elseArm).not.toContain('This is not a verdict');
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
