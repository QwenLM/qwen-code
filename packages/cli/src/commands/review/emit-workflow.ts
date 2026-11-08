/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review emit-workflow`: a complete review roster or a selected wave,
// dispatched by one fixed workflow while preserving the recorded prompts.

import type { CommandModule } from 'yargs';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildLaunch, worktreeResidueOf } from './agent-prompt.js';
import { usableLineCount } from './lib/budget.js';
import {
  ensureWritableReviewWorkflowsDir,
  inertPath,
  reviewWorkflowScriptPath,
} from './lib/paths.js';
import { recordPrompt } from './lib/prompt-record.js';
import { readWorkflowBatches } from './lib/workflow-batch.js';
import type { PlanReport } from './lib/report.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import {
  buildReviewWorkflowScript,
  type WorkflowAgentSpec,
} from './workflow-script.js';

interface EmitWorkflowArgs {
  plan: string;
  rules?: string;
  batch?: string[];
}

/** Unknown size cannot safely select the initial roster's topology. */
export function fanOutBlocker(plan: RosterPlan): string | null {
  if (!usableLineCount(plan.srcDiffLines) || !usableLineCount(plan.diffLines)) {
    return 'this plan carries no usable diff size fields, so its topology is unknown.';
  }
  return null;
}

/**
 * Throw when the plan is one the generated fan-out cannot serve. Called by
 * the handler BEFORE the session directory is created — a blocked plan must
 * leave no empty tree a later sweep finds — and again by the builder, whose
 * contract direct callers rely on.
 */
function refuseBlockedFanOut(plan: RosterPlan): void {
  const blocker = fanOutBlocker(plan);
  if (blocker) {
    throw new Error(
      `emit-workflow: ${blocker} Rebuild the plan before dispatching.`,
    );
  }
}

/**
 * The roster this plan requires, each entry carrying the prompt the
 * hand-launched path would have printed for it.
 *
 * Writes as it goes — `buildLaunch` writes each brief beside the plan, and
 * each prompt is recorded — because those two artifacts ARE the delivery
 * evidence: the brief is what the agent reads, and the record is what
 * `check-coverage` compares the launch against. Building them without writing
 * them would produce a roster no gate could check.
 */
export function buildFanOutRoster(
  report: PlanReport,
  planPath: string,
  rules?: string,
): WorkflowAgentSpec[] {
  const plan = report as RosterPlan;

  refuseBlockedFanOut(plan);

  // The state of the shared review worktree AT BUILD TIME, probed the same
  // way the hand-launched path does (agent-prompt's handler) and threaded
  // into every build below: both paths go through `buildLaunch`, and its
  // byte-parity invariant covers the residue evidence block too. A probe
  // only one path ran would leave the other's briefs silent about a dirty
  // tree — every dispatched agent then reads foreign files as the PR's code,
  // and no gate catches it, because each path records its own prompts and
  // coverage compares like with like.
  const residue = worktreeResidueOf(report);
  if (residue.unmeasured) {
    writeStderrLine(
      `warning: could not measure whether the review worktree is clean (reason: ` +
        `${inertPath(residue.unmeasured)}). Every brief built by this call says so; an unmeasured tree is ` +
        'not a clean one.',
    );
  }
  if (residue.paths.length > 0) {
    const unlisted = residue.total - residue.paths.length;
    writeStderrLine(
      `warning: the review worktree carries changes its commit does not: ${residue.paths
        .map(inertPath)
        .join(', ')}` +
        (unlisted > 0
          ? ` (and ${unlisted} more — this list is capped; \`git status --porcelain --untracked-files=all\` has the full set)`
          : '') +
        '. Every brief built by this call names those paths and says a defect confined to them ' +
        'is not a finding; the code-reading ones also carry the rule that evidence comes from ' +
        '`git show HEAD:<path>`. Restore them BEFORE dispatching the workflow — a probe left in the ' +
        "shared tree reads to an auditor as the PR's own code, and to Agent 7's build and test " +
        "run as the PR's own failure — and then RE-RUN this same command so the script is rebuilt: " +
        'the suppression above is baked into the briefs it writes, so dispatching it after a ' +
        'restore tells every agent to drop findings in a file that is by then exactly the ' +
        "PR's code. (The prompt records are overwritten, so a rebuild is what the delivery " +
        'check compares against.)',
    );
  }

  return requiredAgents(plan).map((req): WorkflowAgentSpec => {
    const { key, prompt } = buildLaunch(
      report,
      planPath,
      req.role === 'chunk'
        ? { chunk: req.chunk }
        : { role: req.role, file: req.file },
      rules,
      residue,
    );
    // The same guard `--roster` makes, for the same reason: the roster is
    // what coverage holds the run to, and the key is what the brief was
    // written under. If they ever disagree, every delivery check downstream
    // reads "brief never reached an agent" on a run that did everything right.
    if (key !== req.key) {
      throw new Error(
        `emit-workflow: built "${key}" where the roster requires "${req.key}" ` +
          '— the agent could never be matched to the requirement. This is a ' +
          'bug in the CLI, not in the call.',
      );
    }
    // What was handed out, at a path derived from the plan. `check-coverage`
    // compares this against the prompt the harness recorded the agent being
    // launched with; an unrecorded launch reads as an agent that never ran.
    recordPrompt(planPath, key, prompt);
    return { key, prompt };
  });
}

function runEmitWorkflow(args: EmitWorkflowArgs): void {
  if (args.batch !== undefined && args.rules !== undefined) {
    throw new Error(
      'emit-workflow: --rules cannot be combined with --batch; project rules are already recorded in each batch.',
    );
  }
  let report: PlanReport;
  try {
    report = JSON.parse(readFileSync(args.plan, 'utf8')) as PlanReport;
  } catch (err) {
    throw new Error(
      `emit-workflow: cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }

  // Same refusal as `agent-prompt`, for the same reason: a rules path that
  // does not resolve would silently review without the project rules the run
  // was told to enforce.
  let rules: string | undefined;
  if (args.rules) {
    try {
      rules = readFileSync(args.rules, 'utf8');
    } catch (err) {
      throw new Error(
        `emit-workflow: cannot read the rules ${args.rules}: ` +
          `${(err as Error).message}. Omit --rules if this review has none.`,
      );
    }
  }

  // Batch manifests already select their roles; only a fresh roster needs
  // the plan's diff sizes to choose its topology.
  if (args.batch === undefined) refuseBlockedFanOut(report as RosterPlan);
  const batchAgents =
    args.batch === undefined
      ? undefined
      : readWorkflowBatches(args.plan, args.batch);

  // Validate the output directory before building any delivery evidence.
  ensureWritableReviewWorkflowsDir();
  const agents = batchAgents ?? buildFanOutRoster(report, args.plan, rules);
  const planWorktree = (report as RosterPlan).worktreePath;
  const script = buildReviewWorkflowScript(
    agents,
    typeof planWorktree === 'string' ? planWorktree : undefined,
  );
  const scriptPath = reviewWorkflowScriptPath(args.plan, script);

  const temporaryPath = `${scriptPath}.${randomUUID()}.tmp`;
  // Temp-and-rename, and the write is inside the cleanup too: a failure
  // mid-write (ENOSPC, EIO) throws AFTER the temp file exists, and a finally
  // that only covered the rename would leave the half-written shape behind.
  // The rename also replaces an existing entry at the target — a symlink
  // planted there is replaced, never written through.
  try {
    writeFileSync(temporaryPath, script, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, scriptPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  // One path and a count. Nothing here is a prompt: the prompts are inside the
  // script, which nobody is asked to read, retype or relay — which is the
  // property this command exists for.
  writeStdoutLine(
    `${agents.length} agents required. The fan-out is a workflow: make ONE ` +
      'Workflow call with the scriptPath below and no `args`, and do not ' +
      'build agent calls by hand for this step.',
  );
  writeStdoutLine(`scriptPath: ${resolve(scriptPath)}`);
}

export const emitWorkflowCommand: CommandModule = {
  command: 'emit-workflow',
  describe:
    'Emit a review roster or selected batch as a runnable workflow script, so it ' +
    'is dispatched by code instead of hand-launched',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the plan report from Step 1',
      })
      .option('rules', {
        type: 'string',
        describe:
          'Path to the project rules from Step 2, if the project has any',
      })
      .option('batch', {
        type: 'string',
        array: true,
        requiresArg: true,
        describe:
          'Manifest paths emitted by agent-prompt --batch for this wave',
      }),
  handler: (argv) => {
    runEmitWorkflow(argv as unknown as EmitWorkflowArgs);
  },
};
