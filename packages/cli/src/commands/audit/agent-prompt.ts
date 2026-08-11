/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit agent-prompt`: print the brief for one audit role — or the
// low tier's reader — with the plan's context assembled in. The /audit skill
// launches its agents with exactly these prompts (one call per roster role),
// so what every agent is told is fixed by code, not improvised by the
// orchestrator.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { readPlanFile } from './lib/read-json.js';
import {
  AUDIT_BRIEFS,
  buildAuditPrompt,
  buildLowReaderPrompt,
  type AuditBriefRole,
} from './lib/audit-agent-briefs.js';

interface AgentPromptArgs {
  plan: string;
  role?: string;
  probes?: 'opted-in' | 'declined';
}

function runAgentPrompt(args: AgentPromptArgs): void {
  const plan = readPlanFile(args.plan, 'agent-prompt');
  const probesConsented = args.probes === 'opted-in';
  // A stale plan JSON can carry anything in its roster — a non-array must
  // fail closed (empty roster, every role refused), never reach .includes.
  const roles = Array.isArray(plan.roster) ? (plan.roster as string[]) : [];
  if (args.role === 'low-reader') {
    if (plan.effort !== 'low') {
      throw new Error(
        `agent-prompt: low-reader is only valid for a low-tier plan (this plan is ${plan.effort}).`,
      );
    }
    writeStdoutLine(buildLowReaderPrompt(plan));
    return;
  }
  const role = args.role as Exclude<AuditBriefRole, 'low-reader'> | undefined;
  // Object.hasOwn, not `in`: a stale-plan role like "toString" matches
  // inherited Object.prototype keys and would emit an undefined brief.
  if (!role || !Object.hasOwn(AUDIT_BRIEFS, role)) {
    throw new Error(
      `agent-prompt: --role must be one of ${[...Object.keys(AUDIT_BRIEFS), 'low-reader'].join(', ')}.`,
    );
  }
  if (!roles.includes(role)) {
    throw new Error(
      `agent-prompt: role ${role} is not in this plan's roster (${roles.join(', ') || 'empty'}). The roster is computed from the plan's effort — regenerate the plan if you need a different tier.`,
    );
  }
  writeStdoutLine(buildAuditPrompt(role, plan, probesConsented));
}

export const agentPromptCommand: CommandModule = {
  command: 'agent-prompt',
  describe:
    'Print the brief for an audit role or the low-tier reader — with plan context assembled',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Plan JSON written by `qwen audit plan-files`',
      })
      .option('role', {
        type: 'string',
        describe: 'Print one role brief (must be in the plan roster)',
      })
      .option('probes', {
        choices: ['opted-in', 'declined'] as const,
        describe:
          'The Step-2 probe opt-in verdict; declined prompts carry no execution instructions (not required for --role low-reader — low runs no execution classes)',
      })
      .check((argv) => {
        if (!argv.role) {
          throw new Error('agent-prompt: pass --role <id>.');
        }
        if (argv.role !== 'low-reader' && !argv.probes) {
          throw new Error(
            'agent-prompt: pass --probes opted-in|declined (the Step-2 probe opt-in).',
          );
        }
        return true;
      }),
  handler: (argv) => {
    runAgentPrompt(argv as unknown as AgentPromptArgs);
  },
};
