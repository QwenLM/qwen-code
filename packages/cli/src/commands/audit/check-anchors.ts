/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit check-anchors`: resolve every finding's anchor snippet against
// the audited files and the registered deep-read callers, at write time.
// A snippet that does not resolve uniquely is refused or downgraded and
// recorded in the report header — never silently shipped.
//
// The findings come from the machine-readable manifest, and the human report
// is checked against it by marker count (see lib/anchors.ts for why the gate
// does not parse the report's prose).

import type { CommandModule } from 'yargs';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  checkReportMarkers,
  ManifestError,
  parseFindingsManifest,
  resolveAnchors,
} from './lib/anchors.js';
import { readCallersFile, readPlanFile } from './lib/read-json.js';
import { AUDIT_READ_MAX_BYTES, readGuarded } from './lib/safe-read.js';

/** Read one agent-authored text artifact. Guarded: these paths are
 *  agent-handed — a writer-less FIFO must not hang the write gate, nor a
 *  multi-GB file exhaust memory. */
function readTextArtifact(path: string, what: string): string {
  const content = readGuarded(path, AUDIT_READ_MAX_BYTES);
  if (content === null) {
    throw new Error(
      `audit check-anchors: cannot read ${what} ${path} — missing, ` +
        `unreadable, not a regular file, or oversized.`,
    );
  }
  return content.toString('utf8');
}

export const checkAnchorsCommand: CommandModule = {
  command: 'check-anchors',
  describe:
    "Resolve the findings manifest's anchor snippets against the audited files and registered callers, and check the report carries one marker per finding",
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Plan JSON written by `qwen audit plan-files`',
      })
      .option('findings', {
        type: 'string',
        demandOption: true,
        describe:
          'The findings manifest (JSON): {"version":1,"findings":[{id,title,severity,locations,anchor}]}',
      })
      .option('report', {
        type: 'string',
        demandOption: true,
        describe:
          'The report draft; every finding block must carry its manifest marker',
      })
      .option('callers', {
        type: 'string',
        describe: 'JSON array of registered deep-read caller absolute paths',
      }),
  handler: (argv) => {
    const { plan, findings, report, callers } = argv as unknown as {
      plan: string;
      findings: string;
      report: string;
      callers?: string;
    };
    const planJson = readPlanFile(plan, 'check-anchors');
    const registeredCallers = callers
      ? readCallersFile(callers, 'check-anchors')
      : [];
    let manifest;
    try {
      manifest = parseFindingsManifest(
        readTextArtifact(findings, 'the findings manifest'),
      );
    } catch (err) {
      // A manifest that is not a manifest is not "some findings need
      // handling" — nothing can be resolved at all. Report it on the same
      // exit code the skill already handles, rather than as a raw stack
      // (exit 1 + a yargs help dump) that would bypass the handling path.
      if (err instanceof ManifestError) {
        writeStderrLine(err.message);
        process.exitCode = 4;
        return;
      }
      throw err;
    }
    const markerProblems = checkReportMarkers(
      readTextArtifact(report, 'the report draft'),
      manifest,
    );
    const results = resolveAnchors(manifest, planJson, registeredCallers);
    writeStdoutLine(JSON.stringify({ markerProblems, results }, null, 2));
    if (
      markerProblems.length > 0 ||
      results.some((r) => r.verdict !== 'resolved')
    ) {
      process.exitCode = 4;
    }
  },
};
