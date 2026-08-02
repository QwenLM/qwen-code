/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit agent-prompt`: print the brief for one audit role, a folded
// chunk territory, or the whole roster — with the plan's context assembled
// in. The /audit skill launches its agents with exactly these prompts, so
// what every agent is told is fixed by code, not improvised by the
// orchestrator.

import type { CommandModule } from 'yargs';
import { readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { AuditRoleId, FilesPlan } from './lib/files-plan.js';
import {
  AUDIT_BRIEFS,
  buildAuditPrompt,
  buildChunkPrompt,
  buildInvariantPrompt,
  type AuditInvariantRole,
} from './lib/audit-agent-briefs.js';

const INVARIANT_ROLES = new Set<string>([
  'invariant-a',
  'invariant-b',
  'invariant-c',
]);

interface AgentPromptArgs {
  plan: string;
  role?: string;
  roster?: boolean;
  chunk?: number;
  file?: string;
}

function runAgentPrompt(args: AgentPromptArgs): void {
  const plan = JSON.parse(readFileSync(args.plan, 'utf8')) as FilesPlan & {
    targetPathAbsolute: string;
  };
  const roles = plan.roster ?? [];
  if (args.role && INVARIANT_ROLES.has(args.role)) {
    if (!args.file) {
      throw new Error(
        `agent-prompt: role ${args.role} requires --file <heavy-file>.`,
      );
    }
    if (args.chunk !== undefined) {
      throw new Error('agent-prompt: invariant roles cannot be chunk-scoped.');
    }
    writeStdoutLine(
      buildInvariantPrompt(args.role as AuditInvariantRole, plan, args.file),
    );
    return;
  }
  if (args.file) {
    throw new Error(
      'agent-prompt: --file is only valid with invariant-a, invariant-b, or invariant-c.',
    );
  }
  if (args.roster) {
    if (roles.length === 0) {
      throw new Error(
        'agent-prompt: the plan carries an empty roster (effort=low is an inline audit — no agents to brief).',
      );
    }
    for (const role of roles) {
      writeStdoutLine(`===== ROLE ${role} =====`);
      writeStdoutLine(buildAuditPrompt(role, plan));
      writeStdoutLine('');
    }
    return;
  }
  if (args.chunk !== undefined) {
    const chunk = plan.chunks.find((c) => c.id === args.chunk);
    if (!chunk) {
      throw new Error(
        `agent-prompt: no chunk ${args.chunk} in this plan (${plan.chunks.length} chunk(s)).`,
      );
    }
    if (args.role === undefined) {
      // Folded territory brief: one agent per chunk, all chunk-scoped
      // dimensions carried (the chunked-topology default).
      writeStdoutLine(buildChunkPrompt(plan, chunk));
      return;
    }
  }
  const role = args.role as AuditRoleId | undefined;
  if (!role || !(role in AUDIT_BRIEFS)) {
    throw new Error(
      `agent-prompt: --role must be one of ${Object.keys(AUDIT_BRIEFS).join(', ')}, or pass --roster / --chunk <id>.`,
    );
  }
  if (!roles.includes(role)) {
    throw new Error(
      `agent-prompt: role ${role} is not in this plan's roster (${roles.join(', ') || 'empty'}). The roster is computed from the plan's effort — regenerate the plan if you need a different tier.`,
    );
  }
  if (args.chunk !== undefined) {
    const chunk = plan.chunks.find((c) => c.id === args.chunk)!;
    if (!plan.chunkScopedRoles?.includes(role)) {
      throw new Error(
        `agent-prompt: role ${role} is not chunk-scoped (${plan.chunkScopedRoles?.join(', ') || 'none'} are) — chunk-scoping it would split a walk that must see the whole module.`,
      );
    }
    writeStdoutLine(buildAuditPrompt(role, plan, chunk));
    return;
  }
  writeStdoutLine(buildAuditPrompt(role, plan));
}

export const agentPromptCommand: CommandModule = {
  command: 'agent-prompt',
  describe:
    'Print the brief for an audit role, a folded chunk territory, or the whole roster — with plan context assembled',
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
      .option('chunk', {
        type: 'number',
        describe:
          'Print the folded territory brief for one chunk; with --role, scope that role to the chunk instead',
      })
      .option('file', {
        type: 'string',
        describe:
          'Heavy file owned by invariant-a, invariant-b, or invariant-c',
      })
      .option('roster', {
        type: 'boolean',
        describe: 'Print every brief the plan roster requires',
      })
      .conflicts('role', 'roster')
      .conflicts('chunk', 'roster')
      .check((argv) => {
        if (!argv.role && !argv.roster && argv.chunk === undefined) {
          throw new Error(
            'agent-prompt: pass --role <id>, --roster, or --chunk <id>.',
          );
        }
        return true;
      }),
  handler: (argv) => {
    runAgentPrompt(argv as unknown as AgentPromptArgs);
  },
};
