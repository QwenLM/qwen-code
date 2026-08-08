/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit snapshot` / `qwen audit drift-check`: the run-start captures
// and checkpoint comparisons of the audit pipeline, kept in code so the
// capture shape and the drift arms are deterministic, not orchestrator prose.

import type { CommandModule } from 'yargs';
import { readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { FilesPlan } from './lib/files-plan.js';
import { captureSidecar, driftCheck } from './lib/sidecar.js';

function readPlan(path: string): FilesPlan {
  return JSON.parse(readFileSync(path, 'utf8')) as FilesPlan;
}

function readCallers(path?: string): string[] {
  if (!path) return [];
  // The callers file is agent-authored — validate the shape before use.
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((c) => typeof c !== 'string' || c === '')
  ) {
    throw new Error(
      'audit snapshot: --callers file must be a JSON array of absolute path strings.',
    );
  }
  return parsed as string[];
}

export const snapshotCommand: CommandModule = {
  command: 'snapshot',
  describe:
    'Capture the run-start sidecar (path-scoped diff, untracked content copies, per-file content hashes) for an audit plan',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Plan JSON written by `qwen audit plan-files`',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe:
          'Sidecar directory (created; next to wherever the report lands)',
      })
      .option('callers', {
        type: 'string',
        describe:
          'JSON array of registered deep-read caller absolute paths (1c registration); their content is copied and hashed alongside',
      }),
  handler: (argv) => {
    const { plan, out, callers } = argv as unknown as {
      plan: string;
      out: string;
      callers?: string;
    };
    const sidecar = captureSidecar(readPlan(plan), out, readCallers(callers));
    writeStdoutLine(
      JSON.stringify(
        {
          capturedAt: sidecar.meta.capturedAt,
          noVcs: sidecar.meta.noVcs,
          captureDegraded: sidecar.meta.captureDegraded ?? [],
          headSha: sidecar.meta.headSha ?? null,
          subtreeHash: sidecar.meta.subtreeHash ?? null,
          hashedFiles: Object.keys(sidecar.hashes).length,
          callers: sidecar.callerNames.length,
        },
        null,
        2,
      ),
    );
  },
};

export const driftCheckCommand: CommandModule = {
  command: 'drift-check',
  describe:
    'Re-check the audited path against the run-start sidecar; reports per-file content drift for the orchestrator to apply the stop/degrade predicate',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Plan JSON written by `qwen audit plan-files`',
      })
      .option('sidecar', {
        type: 'string',
        demandOption: true,
        describe: 'Sidecar directory written by `qwen audit snapshot`',
      }),
  handler: (argv) => {
    const { plan, sidecar } = argv as unknown as {
      plan: string;
      sidecar: string;
    };
    writeStdoutLine(
      JSON.stringify(driftCheck(readPlan(plan), sidecar), null, 2),
    );
  },
};
