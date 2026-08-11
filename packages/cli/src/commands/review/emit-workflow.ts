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
// It is NOT a one-variable change, and the difference that remains is worth
// naming: workflow dispatch substitutes its own terse subagent persona unless
// an `agentType` is given, so the generated script passes
// `agentType: 'general-purpose'` — the same subagent type SKILL.md requires of
// the hand-launched path. Everything else about the dispatch (turn ceiling,
// wall clock) is the workflow runtime's, not the Agent tool's; see the
// limitations in the PR description rather than assuming parity.

import type { CommandModule } from 'yargs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildLaunch } from './agent-prompt.js';
import { recordPrompt } from './lib/prompt-record.js';
import { readPlanReport, type PlanReport } from './lib/report.js';
import { reviewWorkflowScriptPath } from './lib/paths.js';
import {
  isTerritoryFanOut,
  requiredAgents,
  reviewMode,
  type RosterPlan,
} from './lib/roster.js';
import {
  buildReviewWorkflowScript,
  type WorkflowAgentSpec,
} from './workflow-script.js';

interface EmitWorkflowArgs {
  plan: string;
  rules?: string;
}

/**
 * Are workflows available to run what this emits?
 *
 * Mirrors `Config.isWorkflowsEnabled`'s env half. The settings half is not
 * visible from a subcommand, which has no Config — so a project that enabled
 * workflows only through settings is refused here and has to set the env var
 * as well. That is the fail-closed direction: emitting a script nothing can
 * run wastes a step and reports no reason, while this refusal names the
 * variable to set.
 */
export function workflowsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['QWEN_CODE_DISABLE_WORKFLOWS'] === '1') return false;
  return env['QWEN_CODE_ENABLE_WORKFLOWS'] === '1';
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

  // 3B is not a bigger 3A. Its chunk agents carry a per-territory contract —
  // paging rules, the uncoverable rule, a `Covered:` receipt — and its
  // retirement ledger reads transcripts per chunk. Emitting a 3A-shaped
  // fan-out for one would launch the wrong agents over the right diff.
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
  // findings that look plausible and describe the wrong tree.
  const mode = reviewMode(plan);
  if (mode === 'pr-worktree') {
    throw new Error(
      'emit-workflow: this review has a worktree, and a workflow dispatch ' +
        'cannot yet be pinned to it (`agent()` takes no working directory), so ' +
        'its agents would read the main checkout instead of the PR. Use ' +
        '`agent-prompt --roster` for worktree reviews.',
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
  // Checked before anything is written: the refusal is about this environment,
  // not about this plan, and a run that cannot execute what it emits should
  // not leave a script and a set of prompt records behind implying it did.
  if (!workflowsEnabled()) {
    throw new Error(
      'emit-workflow: workflows are not enabled in this environment, so ' +
        'nothing could run what this emits. Set QWEN_CODE_ENABLE_WORKFLOWS=1 ' +
        '(and leave QWEN_CODE_DISABLE_WORKFLOWS unset), or use ' +
        '`agent-prompt --roster` for this review.',
    );
  }

  const report = readPlanReport('emit-workflow', args.plan);

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

  const agents = buildFanOutRoster(report, args.plan, rules);
  const scriptPath = reviewWorkflowScriptPath(args.plan);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, buildReviewWorkflowScript(agents), 'utf8');

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
