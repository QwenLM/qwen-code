/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Parent command for 'qwen review'. Hosts the internal helpers used by
// the /review skill (presubmit checks, post-review cleanup) so the prompt
// can stay short and the logic stays testable.

import type { Argv, CommandModule } from 'yargs';
import { parseArgsCommand } from './review/parse-args.js';
import { matchRemoteCommand } from './review/match-remote.js';
import { composeReviewCommand } from './review/compose-review.js';
import { findingsCommand } from './review/findings.js';
import { recoverFindingsCommand } from './review/recover-findings.js';
import { fetchPrCommand } from './review/fetch-pr.js';
import { captureLocalCommand } from './review/capture-local.js';
import { planDiffCommand } from './review/plan-diff.js';
import { repoContextCommand } from './review/repo-context.js';
import { prContextCommand } from './review/pr-context.js';
import { commentStatusCommand } from './review/comment-status.js';
import { loadRulesCommand } from './review/load-rules.js';
import { presubmitCommand } from './review/presubmit.js';
import { publishAssetsCommand } from './review/publish-assets.js';
import { resolveAnchorsCommand } from './review/resolve-anchors.js';
import { checkCoverageCommand } from './review/check-coverage.js';
import { agentPromptCommand } from './review/agent-prompt.js';
import { buildTestCommand } from './review/build-test.js';
import { baseTreeCommand } from './review/base-tree.js';
import { scratchTreeCommand } from './review/scratch-tree.js';
import { testDeltaCommand } from './review/test-delta.js';
import { driveCommand } from './review/drive.js';
import { abDriveCommand } from './review/ab-drive.js';
import { mockProviderCommand } from './review/mock-provider.js';
import { extractStepCommand } from './review/extract-step.js';
import { scriptLintCommand } from './review/script-lint.js';
import { revertHunkCommand } from './review/revert-hunk.js';
import { submitCommand } from './review/submit.js';
import { testEfficacyCommand } from './review/test-efficacy.js';
import { testPlanCommand } from './review/test-plan.js';
import { cleanupCommand } from './review/cleanup.js';
import { costLedgerCommand } from './review/cost-ledger.js';
import { runCommand } from './review/run.js';
import { saveArtifactCommand } from './review/save-artifact.js';
import { metaCommand } from './review/meta.js';
import { issueContextCommand } from './review/issue-context.js';
import { fetchDiffCommand } from './review/fetch-diff.js';
import { commentBodyCommand } from './review/comment-body.js';

export const reviewCommand: CommandModule = {
  command: 'review',
  describe:
    'Run a review non-interactively (`run`), plus the internal helpers used by the /review skill (PR worktree setup, context fetch, rules loading, presubmit checks, cleanup)',
  builder: (yargs: Argv) =>
    yargs
      .command(runCommand)
      .command(parseArgsCommand)
      .command(matchRemoteCommand)
      .command(metaCommand)
      .command(issueContextCommand)
      .command(fetchDiffCommand)
      .command(commentBodyCommand)
      .command(fetchPrCommand)
      .command(captureLocalCommand)
      .command(planDiffCommand)
      .command(repoContextCommand)
      .command(prContextCommand)
      .command(commentStatusCommand)
      .command(loadRulesCommand)
      .command(agentPromptCommand)
      .command(buildTestCommand)
      .command(baseTreeCommand)
      .command(scratchTreeCommand)
      .command(testDeltaCommand)
      .command(driveCommand)
      .command(abDriveCommand)
      .command(mockProviderCommand)
      .command(extractStepCommand)
      .command(scriptLintCommand)
      .command(revertHunkCommand)
      .command(resolveAnchorsCommand)
      .command(checkCoverageCommand)
      .command(costLedgerCommand)
      .command(presubmitCommand)
      .command(testEfficacyCommand)
      .command(testPlanCommand)
      .command(findingsCommand)
      .command(recoverFindingsCommand)
      .command(publishAssetsCommand)
      .command(composeReviewCommand)
      .command(saveArtifactCommand)
      .command(submitCommand)
      .command(cleanupCommand)
      .demandCommand(
        1,
        'Specify a subcommand: run, parse-args, match-remote, meta, issue-context, fetch-diff, comment-body, fetch-pr, capture-local, plan-diff, repo-context, pr-context, comment-status, load-rules, agent-prompt, build-test, base-tree, scratch-tree, test-delta, drive, ab-drive, mock-provider, extract-step, script-lint, revert-hunk, resolve-anchors, check-coverage, cost-ledger, presubmit, test-efficacy, test-plan, findings, recover-findings, publish-assets, compose-review, save-artifact, submit, or cleanup.',
      )
      .version(false),
  handler: () => {
    // yargs handles this via demandCommand(1) above.
  },
};
