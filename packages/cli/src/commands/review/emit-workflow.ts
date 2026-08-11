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
// writes the same blocks into an args file a script reads, so the fan-out's
// width is a `parallel()` over an array inside the workflow runtime.
//
// The printed contract, and how each half stays executable:
//   - The script goes into the project's saved-workflow dir
//     (`.qwen/workflows/`), because `Workflow({scriptPath})` refuses to load
//     a file from anywhere else — so anywhere else is not emitted.
//   - The Workflow tool's `args` is inline-only (there is no path form), so
//     the printed instruction is to read the args file and pass its PARSED
//     JSON contents. The prompts therefore cross the orchestrator's context
//     once; the coverage gate's verbatim check is what holds that crossing
//     honest — a rewritten or dropped prompt is exactly what it reports.
//
// What is not ready yet, said plainly rather than papered over: check-coverage
// proves delivery from subagent transcripts, and the workflow runtime attaches
// no transcript writer to the agents it dispatches — so a run dispatched from
// these args cannot pass the gate until coverage reads the workflow journal
// instead (#8769). The prompts ARE recorded (that closes the gate's briefless
// half) so nothing built here is lost; until the journal-based gate lands,
// the skill does not route Step 3A through this command.
//
// Scope, and why the refusals below are refusals rather than fallbacks: this
// builds the 3A topology in a tree the run already occupies. A territory
// fan-out (3B) has a richer per-chunk contract, and a worktree review needs
// every agent pinned to the PR worktree — which the workflow runtime cannot
// yet express (`agent()` has no `cwd`). Either would produce a run that looks
// complete and reviewed the wrong thing, so both stop here with the reason.

import type { CommandModule } from 'yargs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildRosterLaunches, rosterLabel } from './agent-prompt.js';
import type { PlanReport } from './lib/report.js';
import {
  isTerritoryFanOut,
  reviewMode,
  type RosterPlan,
} from './lib/roster.js';
import { readPlanFile, readRulesFile } from './lib/plan-file.js';
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
  agents: WorkflowAgentSpec[];
}

/**
 * The name the script is saved under in `.qwen/workflows/`. Doubles as the
 * `workflow('<name>')` handle; kept to the saved-workflow name pattern
 * (lower-case letters, digits, hyphens).
 */
export const REVIEW_STEP_3A_SAVED_SCRIPT_NAME = 'review-step-3a';

/**
 * Build the args payload for a plan, or throw naming the reason it cannot.
 *
 * Writes as it builds: each agent's brief goes beside the plan and each
 * prompt is recorded for the delivery gate. Callers validate and create
 * their output destinations BEFORE calling, so a write that fails there
 * never leaves these records behind.
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
  if (reviewMode(plan) === 'pr-worktree') {
    throw new Error(
      'emit-workflow: this review has a worktree, and a workflow dispatch ' +
        'cannot yet be pinned to it (`agent()` takes no working directory), so ' +
        'its agents would read the main checkout instead of the PR. Use ' +
        '`agent-prompt --roster` for worktree reviews.',
    );
  }

  const agents = buildRosterLaunches(
    report,
    planPath,
    rules,
    'emit-workflow',
  ).map(({ req, key, prompt }): WorkflowAgentSpec => {
    // Record what was built: this is the briefless half of the delivery gate.
    // The gate's other half — harness transcripts proving each prompt reached
    // an agent — is not produced by a workflow dispatch (the runtime attaches
    // no transcript writer to its agents), so a run dispatched from these
    // args cannot pass check-coverage until coverage reads the workflow
    // journal instead (#8769). The record is still owed: it is what the
    // journal-based gate will pair the journal against.
    recordPrompt(planPath, key, prompt);
    return { key, label: rosterLabel(req), prompt };
  });

  return { version: 1, agents };
}

/**
 * The plan must be shaped like a plan, not merely parse. A JSON object that
 * is not a plan report otherwise dies deep in the roster internals — or,
 * worse, a partial one silently emits a full roster that check-coverage then
 * reads as obligations.
 */
function requirePlanShape(report: PlanReport, planPath: string): void {
  // The validator sees the raw JSON's fields, not just the roster's view of
  // them: `diffPathAbsolute` is written by the capturing command and read by
  // the coverage gate, but the roster itself never needs it.
  const plan = report as RosterPlan & { diffPathAbsolute?: unknown };
  if (typeof plan.diffPathAbsolute !== 'string' || !plan.diffPathAbsolute) {
    throw new Error(
      `emit-workflow: the plan ${planPath} has no diffPathAbsolute — it is ` +
        'not a plan report.',
    );
  }
  if (!Array.isArray(plan.chunks) || plan.chunks.length === 0) {
    throw new Error(
      `emit-workflow: the plan ${planPath} has no chunks[] — it is not a ` +
        'plan report.',
    );
  }
  if (!Array.isArray(plan.files)) {
    throw new Error(
      `emit-workflow: the plan ${planPath} has no files[] — it is not a ` +
        'plan report.',
    );
  }
}

/** Workflows are experimental and opt-in; see Config.isWorkflowsEnabled(). */
function workflowsEnabled(): boolean {
  // The kill switch, then the opt-in env var. `isWorkflowsEnabled()` also
  // reads a config flag, but no settings source ever sets it — the env var
  // is the only live enable path today, so this check is exact, not an
  // approximation. If that wiring changes, change this with it.
  if (process.env['QWEN_CODE_DISABLE_WORKFLOWS'] === '1') return false;
  return process.env['QWEN_CODE_ENABLE_WORKFLOWS'] === '1';
}

/**
 * Validate and create both output destinations BEFORE anything is built.
 *
 * The script goes into the project's saved-workflow dir because
 * `Workflow({scriptPath})` refuses to load a file from anywhere else; the
 * args file goes where `--out` says. Both fail closed on a pre-existing
 * target — silently clobbering a file the user already had (a `script.js`
 * in a populated directory is not necessarily ours) is not an option.
 */
function prepareOutputs(outArg: string): {
  argsPath: string;
  scriptPath: string;
} {
  const outDir = resolve(outArg);
  const argsPath = resolve(outDir, 'args.json');
  const scriptPath = resolve(
    process.cwd(),
    '.qwen',
    'workflows',
    `${REVIEW_STEP_3A_SAVED_SCRIPT_NAME}.js`,
  );
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    throw new Error(
      `emit-workflow: cannot create the --out directory ${outDir}: ` +
        `${(err as Error).message}`,
    );
  }
  try {
    if (existsSync(argsPath)) {
      throw new Error(
        `${argsPath} already exists — refusing to overwrite it; point ` +
          '--out at a fresh directory.',
      );
    }
    if (existsSync(scriptPath)) {
      // An idempotent re-emit of this command's own script is fine; anything
      // else at that path is the user's and is left alone.
      if (readFileSync(scriptPath, 'utf8') !== REVIEW_STEP_3A_WORKFLOW_SCRIPT) {
        throw new Error(
          `${scriptPath} already exists and is not the script this command ` +
            'writes — refusing to overwrite it.',
        );
      }
    } else {
      mkdirSync(dirname(scriptPath), { recursive: true });
    }
  } catch (err) {
    throw new Error(`emit-workflow: ${(err as Error).message}`);
  }
  return { argsPath, scriptPath };
}

function runEmitWorkflow(args: EmitWorkflowArgs): void {
  // Before ANY write — this command's output is one Workflow call, and a
  // session without the Workflow tool has nothing to call. Refusing here
  // leaves no briefs and no prompt records behind for a run that cannot
  // start; `--roster` remains and is self-sufficient.
  if (!workflowsEnabled()) {
    throw new Error(
      "emit-workflow: workflows are disabled, and this command's output is " +
        'a Workflow call. They are experimental and opt-in — set ' +
        'QWEN_CODE_ENABLE_WORKFLOWS=1 to enable them. Until then, use ' +
        '`agent-prompt --roster` for this review.',
    );
  }

  const report = readPlanFile(args.plan, 'emit-workflow');
  requirePlanShape(report, args.plan);
  const rules = args.rules
    ? readRulesFile(args.rules, 'emit-workflow')
    : undefined;

  const { argsPath, scriptPath } = prepareOutputs(args.out);

  const payload = buildWorkflowArgs(report, args.plan, rules);

  try {
    writeFileSync(scriptPath, REVIEW_STEP_3A_WORKFLOW_SCRIPT, 'utf8');
    writeFileSync(argsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (err) {
    throw new Error(
      `emit-workflow: cannot write the emitted workflow: ` +
        `${(err as Error).message}`,
    );
  }

  // The contract, printed exactly as the Workflow tool can honor it: one
  // call, the script by its saved path, and the args as their parsed JSON
  // contents — `args` is inline-only on the tool, so the file's path is not
  // something the call can take. Nothing here is a prompt; the prompts are
  // in the args file, and what crosses the orchestrator's context is that
  // file's parsed contents, passed unedited.
  writeStdoutLine(
    `${payload.agents.length} agents required. The fan-out is a workflow — ` +
      'read the args file below, then make ONE Workflow call: ' +
      "Workflow({ scriptPath: <the path below>, args: <the args file's " +
      'PARSED JSON contents, passed as a value, not a path> }). Do not ' +
      'build agent calls by hand for this step, and do not edit or drop ' +
      'anything in the args — the coverage gate reads a rewritten prompt ' +
      'as a delivery failure.',
  );
  writeStdoutLine(`scriptPath: ${scriptPath}`);
  writeStdoutLine(
    `args file: ${argsPath} — pass its parsed JSON contents inline as ` +
      '`args` (the Workflow tool takes args inline; there is no path form).',
  );
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
        describe: 'Directory to write args.json into',
      }),
  handler: (argv) => {
    runEmitWorkflow(argv as unknown as EmitWorkflowArgs);
  },
};
