/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review emit-workflow`: the Step 3A fan-out as a workflow the runtime
// dispatches, instead of a roster the orchestrator hand-launches.
//
// `--roster` and this command build the same prompts from the same plan
// through the same function. What differs is who launches them. `--roster`
// prints ~13 blocks and asks the orchestrator to copy each one into an agent
// call, in a single response, without editing any of them — three conventions
// that this skill's gate list exists because they get broken. This command
// writes the same blocks into a file a script reads, so the orchestrator makes
// one tool call naming a path: the fan-out's width is a `parallel()` over an
// array, and the prompts are values passed by code.
//
// What this command deliberately does NOT change: the briefs, the prompts, the
// roster, and how findings come back. The agents are the same agents reading
// the same briefs. That is the point — the A/B this is built for compares two
// dispatchers, and a run that also changed the finding format would be
// comparing two of everything.
//
// Scope, and why the refusals below are refusals rather than fallbacks: this
// builds the 3A topology in a tree the run already occupies. A territory
// fan-out (3B) has a richer per-chunk contract, and a worktree review needs
// every agent pinned to the PR worktree — which the workflow runtime cannot
// yet express (`agent()` has no `cwd`). Either would produce a run that looks
// complete and reviewed the wrong thing, so both stop here with the reason.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildRosterLaunches, rosterLabel } from './agent-prompt.js';
import type { PlanReport } from './lib/report.js';
import {
  isTerritoryFanOut,
  requiredAgents,
  reviewMode,
  type RosterPlan,
} from './lib/roster.js';
import { recordPrompt } from './lib/prompt-record.js';
import { REVIEW_STEP_3A_WORKFLOW_SCRIPT } from './workflow-script.js';

interface EmitWorkflowArgs {
  plan: string;
  rules?: string;
  out: string;
}

/** One agent, as the script receives it. */
export interface WorkflowAgentSpec {
  /** The roster key — `check-coverage` looks the agent up under this. */
  key: string;
  /** Human-readable identity, for the run's progress display. */
  label: string;
  /** The launch prompt, verbatim from `buildLaunch`. Passed, never built. */
  prompt: string;
}

/** The `args` payload the emitted script reads. */
export interface WorkflowArgsFile {
  /** Bumped when the script's expectations of this file change. */
  version: 1;
  /** The plan these agents were derived from. */
  plan: string;
  /** `local` or `diff-only` — `pr-worktree` is refused (see the header). */
  mode: string;
  agents: WorkflowAgentSpec[];
}

/**
 * Build the args payload for a plan, or throw naming the reason it cannot.
 *
 * Separated from the command boundary so the refusals and the roster
 * derivation are testable without a filesystem round trip.
 */
export function buildWorkflowArgs(
  report: PlanReport,
  planPath: string,
  rules?: string,
): WorkflowArgsFile {
  const plan = report as RosterPlan;

  // 3B is not a bigger 3A. Its chunk agents carry a per-territory contract —
  // paging rules, an uncoverable rule, a `Covered:` receipt — and its
  // retirement ledger reads transcripts per chunk. Emitting a 3A-shaped
  // fan-out for it would launch the wrong agents over the right diff.
  if (isTerritoryFanOut(plan)) {
    throw new Error(
      'emit-workflow: this plan is a territory fan-out (Step 3B) and this ' +
        'build emits the Step 3A roster only. Use `agent-prompt --roster` for ' +
        'this review.',
    );
  }

  // Every review agent is pinned to the PR worktree today (`working_dir` on
  // the Agent tool). A workflow dispatch has no equivalent, so the agents
  // would run in the user's main checkout and review whatever is there —
  // producing findings that look plausible and describe the wrong tree.
  const mode = reviewMode(plan);
  if (mode === 'pr-worktree') {
    throw new Error(
      'emit-workflow: this review has a worktree, and a workflow dispatch ' +
        'cannot yet be pinned to it (`agent()` takes no working directory), so ' +
        'its agents would read the main checkout instead of the PR. Use ' +
        '`agent-prompt --roster` for worktree reviews.',
    );
  }

  // `role: 'chunk'` only appears in a territory fan-out, which is refused
  // above. Assert rather than assume, and before anything is built: a future
  // roster change that emitted one here would otherwise ride the shared
  // mapper into a 3B-shaped agent inside the 3A fan-out.
  const chunk = requiredAgents(plan).find((r) => r.role === 'chunk');
  if (chunk) {
    throw new Error(
      `emit-workflow: the roster produced a chunk agent (${chunk.key}) for a ` +
        'plan that is not a territory fan-out. This is a bug in the CLI.',
    );
  }

  const agents = buildRosterLaunches(report, planPath, rules).map(
    ({ req, key, prompt }): WorkflowAgentSpec => {
      // The delivery gate reads recorded prompts, not briefs: without this
      // record, a run dispatched from these args would fail check-coverage as
      // "briefless" despite reviewing with exactly the built prompts.
      recordPrompt(planPath, key, prompt);
      return { key, label: rosterLabel(req), prompt };
    },
  );

  return { version: 1, plan: planPath, mode, agents };
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
  // does not resolve would silently review without the project rules it was
  // told to enforce.
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

  const payload = buildWorkflowArgs(report, args.plan, rules);

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const scriptPath = resolve(outDir, 'script.js');
  const argsPath = resolve(outDir, 'args.json');
  writeFileSync(scriptPath, REVIEW_STEP_3A_WORKFLOW_SCRIPT, 'utf8');
  writeFileSync(argsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  // Two paths and a count. Nothing here is a prompt: the prompts are in the
  // args file, which no one is asked to read, retype, or relay.
  writeStdoutLine(
    `${payload.agents.length} agents required. The fan-out is a workflow — ` +
      'make one Workflow call with the paths below and do not build agent ' +
      'calls by hand for this step.',
  );
  writeStdoutLine(`scriptPath: ${scriptPath}`);
  writeStdoutLine(`args: ${argsPath}`);
}

export const emitWorkflowCommand: CommandModule = {
  command: 'emit-workflow',
  describe:
    'Emit the Step 3A fan-out as a workflow script plus its args, so the ' +
    'roster is dispatched by code instead of hand-launched',
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
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Directory to write script.js and args.json into',
      }),
  handler: (argv) => {
    runEmitWorkflow(argv as unknown as EmitWorkflowArgs);
  },
};
