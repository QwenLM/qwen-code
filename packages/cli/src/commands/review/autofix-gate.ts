/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review autofix-gate`: deterministic decision for /review Step 8
// (autofix). Replaces the previous prose rule "skip Step 8 if --comment was
// specified or this is a cross-repo PR" — that rule lived only in the
// SKILL.md prompt and was easy for a weakly instruction-following model to
// ignore. This subcommand reads the fetch-pr report (the session source of
// truth) and prints a JSON decision the LLM driver follows mechanically:
//
//   {"decision": "skip" | "ask" | "noop", "reason": "..."}
//
//   skip: do not even ask the user to apply auto-fixes (commentMode or
//         cross-repo lightweight mode).
//   noop: there are no auto-fixable findings — Step 8 is a no-op.
//   ask:  prompt the user normally.
//
// For local-uncommitted or file-path reviews, no fetch-pr report exists; the
// gate falls back to the findings-count check (skip rules don't apply).

import type { CommandModule } from 'yargs';
import { existsSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { anchoredPath } from './lib/paths.js';
import {
  addOwnerRepoOption,
  ownerRepoMatches,
  readFetchReport,
} from './lib/session.js';

interface AutofixGateArgs {
  target: string;
  'findings-count': number;
  'owner-repo'?: string;
}

interface AutofixDecision {
  decision: 'skip' | 'ask' | 'noop';
  reason: string;
}

function decide(
  target: string,
  findingsCount: number,
  ownerRepo: string | undefined,
): AutofixDecision {
  // PR target → consult the fetch-pr report. Anything else (local, filename)
  // never had --comment / cross-repo modes, so only the findings-count check
  // applies.
  const prMatch = /^pr-(\d+)$/.exec(target);
  if (prMatch) {
    const prNumber = prMatch[1];
    // For PR targets `--owner-repo` is required so the gate can verify
    // session binding (matching pr-context / presubmit / load-rules --pr /
    // deterministic --pr). Without it the gate would silently read any
    // stale report that happens to exist for this PR number in another
    // repo — exactly the cross-repo stale-session attack the binding
    // closes for the other four gated subcommands. Return `skip` rather
    // than throw so autofix-gate keeps its "always emits a decision JSON,
    // never crashes Step 8" contract.
    if (!ownerRepo) {
      return {
        decision: 'skip',
        reason: `--owner-repo is required for PR-target autofix-gate so the session binding can be verified. Re-invoke as \`qwen review autofix-gate pr-${prNumber} --findings-count <N> --owner-repo <owner>/<repo>\`.`,
      };
    }
    const report = readFetchReport(prNumber);
    if (!report) {
      // No fetch-pr report for a PR target means the LLM driver jumped
      // straight to Step 8 without setting up the worktree. Earlier gates
      // (pr-context / presubmit) already hard-fail on this, but if the model
      // somehow reached us anyway, refuse to prompt the user — autofix would
      // either edit the wrong tree or run against a directory that does not
      // exist. `skip` is strictly safer than `ask` here.
      return {
        decision: 'skip',
        reason: `No fetch-pr report for PR #${prNumber}; cannot determine autofix safety. Re-run \`qwen review fetch-pr\` first.`,
      };
    }
    // Same skip-on-mismatch shape as the missing-report branch — the gate
    // is "soft skip on broken session" by contract. Mismatch counts as
    // broken because the stale report's commentMode flag would otherwise
    // be honoured for a different repo's PR review. Shared
    // `ownerRepoMatches` predicate so any future normalization (GHES
    // hostnames, trailing slashes, ...) lands in one place and both
    // `requireFetchReportFor` and autofix-gate inherit it.
    if (!ownerRepoMatches(report, ownerRepo)) {
      return {
        decision: 'skip',
        reason: `Fetch-pr report for PR #${prNumber} is bound to ${report.ownerRepo}, not ${ownerRepo}; refusing to autofix against a stale cross-repo worktree. Re-run \`qwen review fetch-pr ${prNumber} ${ownerRepo}\` to refresh the session.`,
      };
    }
    // The session is bound to the right repo, but the worktree it
    // points at may have been removed (an unrelated `qwen review
    // cleanup` ran, the user manually deleted the directory, …) while
    // the report stayed on disk. Editing files inside a non-existent
    // worktree would land them on the user's main tree — refuse.
    const worktreeDir = anchoredPath(report.worktreePath);
    if (!existsSync(worktreeDir)) {
      return {
        decision: 'skip',
        reason: `Fetch-pr report for PR #${prNumber} points at ${report.worktreePath}, but that directory does not exist. Re-run \`qwen review fetch-pr ${prNumber} ${ownerRepo}\` to recreate the worktree.`,
      };
    }
    if (report.commentMode) {
      return {
        decision: 'skip',
        reason:
          '/review was invoked with --comment; Step 8 (autofix) is suppressed in favour of inline PR comments.',
      };
    }
    // Real lightweight mode (no matching remote, no worktree) is already
    // caught by the missing-report branch above — `fetch-pr` only writes a
    // report when it created a worktree. For fork PRs reviewed via a
    // configured `upstream` remote, `gh pr view --json isCrossRepository`
    // still returns `true` even though a real worktree with editable files
    // exists. Skipping autofix on `isCrossRepository` alone would block the
    // common fork-PR-via-upstream workflow that SKILL.md Step 1 explicitly
    // supports. Push failure for forks is handled in SKILL.md Step 8.
  }

  if (findingsCount <= 0) {
    return {
      decision: 'noop',
      reason: 'No auto-fixable findings to apply.',
    };
  }
  return {
    decision: 'ask',
    reason: `${findingsCount} auto-fixable finding(s) — prompt the user before applying.`,
  };
}

function runAutofixGate(args: AutofixGateArgs): void {
  const decision = decide(
    args.target,
    args['findings-count'],
    args['owner-repo'],
  );
  // Single-line JSON so a `jq` invocation in a shell wrapper can parse it
  // without juggling whitespace.
  writeStdoutLine(JSON.stringify(decision));
}

export const autofixGateCommand: CommandModule = {
  command: 'autofix-gate <target>',
  describe:
    'Decide whether /review Step 8 (autofix) should skip / noop / prompt — reads the fetch-pr report so the rule is enforced in code, not prose.',
  builder: (yargs) =>
    addOwnerRepoOption(
      yargs
        .positional('target', {
          type: 'string',
          demandOption: true,
          describe:
            'Review target — "pr-<n>" for a PR review, "local" for an uncommitted review, or a filename for a file review.',
        })
        .option('findings-count', {
          type: 'number',
          default: 0,
          describe:
            'Number of auto-fixable findings detected by Step 7. The session-state checks (commentMode set, missing fetch-pr report, cross-repo report mismatch) take precedence and produce "skip" before this value is consulted; otherwise 0 yields "noop" and non-zero yields "ask".',
        }),
    ),
  handler: (argv) => {
    runAutofixGate(argv as unknown as AutofixGateArgs);
  },
};
