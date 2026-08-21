/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review emit-workflow`: the Step 3A fan-out as a workflow the runtime
// dispatches, instead of a roster the orchestrator hand-launches.
//
// `--roster` and this command build the same prompts from the same plan
// through the same function (`buildLaunch`). What differs is who launches
// them. `--roster` prints ~13 blocks and asks the orchestrator to copy each
// one into an agent call, in a single response, without editing any of them —
// three conventions this skill's gate list exists because they get broken.
// This command writes those prompts into a script file, so the orchestrator's
// call carries one path and no payload.
//
// What this does NOT change, deliberately: the briefs, the prompts, the
// roster, the coverage evidence, and how findings come back. The agents are
// the same agents reading the same briefs. That is what makes an A/B against
// the hand-launched path readable.
//
// It is NOT a one-variable change, and the differences that remain are worth
// naming. Workflow dispatch substitutes its own terse subagent persona unless
// an `agentType` is given, so the generated script passes
// `agentType: 'general-purpose'` — the same subagent type SKILL.md requires of
// the hand-launched path — and it passes `workingDir` for the same reason the
// hand-launched path sets `working_dir`: an unpinned agent reads the user's
// main checkout. Everything else about the dispatch (turn ceiling, wall clock)
// is the workflow runtime's, not the Agent tool's.
//
// The one difference no option closes yet is delivery: every agent's text
// comes back inside ONE Workflow tool result, under the scheduler's global
// output budget, where the hand-launched path gets one 32 000-char Agent
// result each. That is why `structuralBlocker` still refuses a territory
// fan-out, whose roster grows with the diff — see orchestration.ts.

import type { CommandModule } from 'yargs';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildLaunch, worktreeResidueOf } from './agent-prompt.js';
import { recordPrompt } from './lib/prompt-record.js';
import { readPlanReport, type PlanReport } from './lib/report.js';
import {
  findSymlinkedReviewWorkflowPath,
  inertPath,
  reviewWorkflowScriptPath,
} from './lib/paths.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import {
  resolveOrchestration,
  structuralBlocker,
} from './lib/orchestration.js';
import {
  buildReviewWorkflowScript,
  type WorkflowAgentSpec,
} from './workflow-script.js';

/**
 * Exit code for "this review runs on the legacy path".
 *
 * A distinct code, not a failure and not a silent exit 0, because the caller
 * has to branch on it: exit 0 means a script exists to run, exit 6 means build
 * the roster the old way, and exit 1 means something is broken. Collapsing the
 * middle case into either neighbour is what turns a routine ineligibility into
 * either a swallowed error or an abandoned review. Mirrors the reverse-audit
 * builder's exit 4 (budget stop) and exit 5 (converged), which are termination
 * verdicts in the same sense.
 */
export const EXIT_LEGACY_ORCHESTRATION = 6;

export { workflowsEnabled } from './lib/orchestration.js';

interface EmitWorkflowArgs {
  plan: string;
  rules?: string;
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

  // The env half of eligibility is the command's, decided before anything is
  // written. What is left here is what this plan itself cannot express — the
  // same facts `resolveOrchestration` routes on, read from the same function,
  // so a caller reaching this with an ineligible plan is refused rather than
  // handed a roster the script cannot dispatch.
  const blocker = structuralBlocker(plan);
  if (blocker) {
    throw new Error(
      `emit-workflow: ${blocker} Use \`agent-prompt --roster\` for this review.`,
    );
  }

  // The state of the shared review worktree AT BUILD TIME, probed the same
  // way the hand-launched path does (agent-prompt's handler) and threaded
  // into every build below: both paths go through `buildLaunch`, and its
  // byte-parity invariant covers the residue evidence block too. A probe
  // only the roster ran used to leave this path's briefs silent about a
  // dirty tree — every dispatched agent then read foreign files as the PR's
  // code, and no gate caught it, because each path records its own prompts
  // and coverage compares like with like.
  const residue = worktreeResidueOf(report);
  if (residue.unmeasured) {
    writeStderrLine(
      `warning: could not measure whether the review worktree is clean (git status failed: ` +
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
      // `role: 'chunk'` reaches this only from a territory fan-out, refused
      // above; `buildLaunch`'s own chunk branch handles it if that ever
      // changes, so there is nothing to assert here.
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
  const report = readPlanReport('emit-workflow', args.plan);

  // Decided before anything is written. A run that will not take the workflow
  // path must not leave a script and a set of prompt records behind implying
  // it did — the records are what `check-coverage` matches launches against,
  // so records for a fan-out that never dispatched would read as a roster
  // that was launched and returned nothing.
  const verdict = resolveOrchestration(report as RosterPlan);
  if (verdict.mode === 'legacy') {
    writeStderrLine(`orchestration: legacy — ${verdict.reason}`);
    writeStderrLine(
      'Build the roster with `qwen review agent-prompt --roster` and launch ' +
        'it as Step 3A describes. This is a routing verdict, not an error: ' +
        'nothing was written and nothing needs repairing.',
    );
    process.exitCode = EXIT_LEGACY_ORCHESTRATION;
    return;
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

  const unsafePath = findSymlinkedReviewWorkflowPath();
  if (unsafePath) {
    throw new Error(
      `emit-workflow: refusing to save through a symlinked saved-workflow path component: '${unsafePath}'.`,
    );
  }

  const scriptPath = reviewWorkflowScriptPath(args.plan);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const createdUnsafePath = findSymlinkedReviewWorkflowPath();
  if (createdUnsafePath) {
    throw new Error(
      `emit-workflow: refusing to save through a symlinked saved-workflow path component: '${createdUnsafePath}'.`,
    );
  }

  const agents = buildFanOutRoster(report, args.plan, rules);
  const temporaryPath = `${scriptPath}.${randomUUID()}.tmp`;
  // The write is inside the cleanup too: a failure mid-write (ENOSPC, EIO)
  // throws AFTER the temp file exists, and a finally that only covers the
  // rename would leave that half-written shape in the saved-workflow dir
  // forever — cleanup removes only the exact script paths.
  try {
    // The worktree pin travels with the roster. `plan.worktreePath` is the
    // same value `agent-prompt --roster` tells the orchestrator to put in
    // `working_dir` on every Agent call, so both paths pin the same tree by
    // construction rather than by two conventions kept in step.
    const planWorktree = (report as RosterPlan).worktreePath;
    const worktreePath =
      typeof planWorktree === 'string' ? planWorktree : undefined;
    writeFileSync(
      temporaryPath,
      buildReviewWorkflowScript(agents, worktreePath),
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
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
    'Emit the Step 3A fan-out as a runnable workflow script, so the roster ' +
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
      }),
  handler: (argv) => {
    runEmitWorkflow(argv as unknown as EmitWorkflowArgs);
  },
};
