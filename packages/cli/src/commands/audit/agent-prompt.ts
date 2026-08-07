/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit agent-prompt`: print the brief for one audit role — or the
// whole roster — with the plan's context assembled in. The /audit skill
// launches its agents with exactly these prompts, so what every agent is
// told is fixed by code, not improvised by the orchestrator.

import type { CommandModule } from 'yargs';
import { readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { FilesPlan } from './lib/files-plan.js';
import {
  AUDIT_BRIEFS,
  buildAuditPrompt,
  buildLowReaderPrompt,
  type AuditBriefRole,
} from './lib/audit-agent-briefs.js';

interface AgentPromptArgs {
  plan: string;
  role?: string;
  roster?: boolean;
  probes?: 'opted-in' | 'declined';
}

function runAgentPrompt(args: AgentPromptArgs): void {
  const plan = JSON.parse(readFileSync(args.plan, 'utf8')) as FilesPlan;
  const probesConsented = args.probes === 'opted-in';
  // A stale plan JSON can carry anything in its roster — validate at the
  // cast instead of letting an unknown id throw mid-stream.
  const roles = (plan.roster ?? []) as string[];
  if (args.roster) {
    if (roles.length === 0) {
      throw new Error(
        'agent-prompt: the plan carries an empty roster (effort=low launches a single reader — use --role low-reader).',
      );
    }
    for (const role of roles) {
      if (!(role in AUDIT_BRIEFS)) {
        throw new Error(
          `agent-prompt: the plan roster contains an unknown role '${role}' — regenerate the plan.`,
        );
      }
      writeStdoutLine(`===== ROLE ${role} =====`);
      writeStdoutLine(
        buildAuditPrompt(
          role as Exclude<AuditBriefRole, 'low-reader'>,
          plan,
          probesConsented,
        ),
      );
      writeStdoutLine('');
    }
    return;
  }
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
  if (!role || !(role in AUDIT_BRIEFS)) {
    throw new Error(
      `agent-prompt: --role must be one of ${[...Object.keys(AUDIT_BRIEFS), 'low-reader'].join(', ')}, or pass --roster.`,
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
    'Print the brief for an audit role, the low-tier reader, or the whole roster — with plan context assembled',
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
      .option('roster', {
        type: 'boolean',
        describe: 'Print every brief the plan roster requires',
      })
      .option('probes', {
        choices: ['opted-in', 'declined'] as const,
        describe:
          'The Step-2 probe opt-in verdict; declined prompts carry no execution instructions (not required for --role low-reader — low runs no execution classes)',
      })
      .conflicts('role', 'roster')
      .check((argv) => {
        if (!argv.role && !argv.roster) {
          throw new Error('agent-prompt: pass --role <id> or --roster.');
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
