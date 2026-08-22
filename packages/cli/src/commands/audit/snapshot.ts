/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit snapshot` / `qwen audit drift-check`: the run-start captures
// and checkpoint comparisons of the audit pipeline, kept in code so the
// capture shape and the drift arms are deterministic, not orchestrator prose.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { captureSidecar, driftCheck } from './lib/sidecar.js';
import { readCallersFile, readPlanFile } from './lib/read-json.js';

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
    const sidecar = captureSidecar(
      readPlanFile(plan, 'snapshot'),
      out,
      callers ? readCallersFile(callers, 'snapshot') : [],
    );
    writeStdoutLine(
      JSON.stringify(
        {
          capturedAt: sidecar.meta.capturedAt,
          noVcs: sidecar.meta.noVcs,
          vcsProbeFailed: sidecar.meta.vcsProbeFailed ?? false,
          captureDegraded: sidecar.meta.captureDegraded ?? [],
          recaptured: sidecar.meta.recaptured ?? null,
          headSha: sidecar.meta.headSha ?? null,
          headUnborn: sidecar.meta.headUnborn ?? false,
          subtreeHash: sidecar.meta.subtreeHash ?? null,
          hashedFiles: Object.keys(sidecar.hashes).length,
          callers: sidecar.callerNames.length,
          // Refusals are published, never silent: a registration the policy
          // dropped is coverage the report header has to disclose, and the
          // orchestrator cannot see the sidecar file itself.
          refusedCallers: sidecar.refusedCallers ?? [],
          // uncoverableNames is written and shape-validated in the
          // sidecar; the count is disclosed here, where the capture
          // contract is published.
          uncoverable: sidecar.uncoverableNames.length,
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
      JSON.stringify(
        driftCheck(readPlanFile(plan, 'drift-check'), sidecar),
        null,
        2,
      ),
    );
  },
};
