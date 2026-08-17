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
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildLaunch } from './agent-prompt.js';
import { recordPrompt } from './lib/prompt-record.js';
import { readPlanReport, type PlanReport } from './lib/report.js';
import { reviewWorkflowScriptPath } from './lib/paths.js';
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
