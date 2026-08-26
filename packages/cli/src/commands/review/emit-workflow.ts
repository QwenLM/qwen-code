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
// Nothing routes through this command yet. The skill still builds its roster
// with `agent-prompt --roster`; this command exists so the generated dispatch
// can be evaluated on its own before the skill is taught to ask for it.

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
import { isTerritoryFanOut, usableLineCount } from './lib/budget.js';
import { inertPath, reviewWorkflowScriptPath } from './lib/paths.js';
import { recordPrompt } from './lib/prompt-record.js';
import type { PlanReport } from './lib/report.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import {
  buildReviewWorkflowScript,
  type WorkflowAgentSpec,
} from './workflow-script.js';

interface EmitWorkflowArgs {
  plan: string;
  rules?: string;
}

/**
 * What about this plan the generated fan-out cannot serve. `null` when
 * nothing does.
 *
 * Every entry names a fact about what the workflow path cannot do yet, not a
 * policy dial, so the list shrinks as the runtime gains capability.
 */
export function fanOutBlocker(plan: RosterPlan): string | null {
  // The size ruling must precede the topology ruling: `isTerritoryFanOut`
  // coerces a missing or null size to 0, so a plan whose counts failed to
  // arrive — an older CLI's, or ones `JSON.stringify` corrupted from `NaN`
  // to `null` — would classify as "not a territory fan-out" and be baked
  // into a script as if it were small. Unknown size is not small size.
  if (!usableLineCount(plan.srcDiffLines) || !usableLineCount(plan.diffLines)) {
    return (
      'this plan carries no usable diff size fields, so its topology is ' +
      'unknown and it may be a territory fan-out.'
    );
  }

  // Both paths build the same chunk prompts through `buildLaunch`, and the
  // emitter is topology-agnostic — a 3B roster serializes exactly like a 3A
  // one. What differs is DELIVERY: the hand-launched path returns one Agent
  // tool result per agent, each with its own output budget, while a workflow
  // returns every agent's text inside ONE Workflow tool result under the
  // scheduler-wide threshold. A 3A roster is bounded; a 3B roster is one
  // agent per chunk plus the whole-diff agents, so it grows with the diff and
  // the loss grows with it, without bound. This blocks on the roster's
  // growth, not on the topology name, so it lifts the moment the workflow
  // result carries a fan-out-sized budget.
  if (isTerritoryFanOut(plan)) {
    return (
      'this plan is a territory fan-out (Step 3B), whose roster grows one ' +
      'agent per chunk, and a workflow returns every agent through one tool ' +
      'result under the scheduler-wide output budget — so the larger the ' +
      'fan-out, the more of it is silently truncated away.'
    );
  }

  return null;
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

  const blocker = fanOutBlocker(plan);
  if (blocker) {
    throw new Error(
      `emit-workflow: ${blocker} Use \`agent-prompt --roster\` for this review.`,
    );
  }

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

  // Resolved BEFORE anything is written: the env contract can be missing, and
  // a roster whose briefs and records were written for a script that then had
  // nowhere to go would read to the coverage gate as a launched fan-out that
  // returned nothing.
  const scriptPath = reviewWorkflowScriptPath(args.plan);

  const agents = buildFanOutRoster(report, args.plan, rules);

  mkdirSync(dirname(scriptPath), { recursive: true });
  const temporaryPath = `${scriptPath}.${randomUUID()}.tmp`;
  // Temp-and-rename, and the write is inside the cleanup too: a failure
  // mid-write (ENOSPC, EIO) throws AFTER the temp file exists, and a finally
  // that only covered the rename would leave the half-written shape behind.
  // The rename also replaces an existing entry at the target — a symlink
  // planted there is replaced, never written through.
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
      { encoding: 'utf8', flag: 'wx' },
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
