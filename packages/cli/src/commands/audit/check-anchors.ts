/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit check-anchors`: resolve every finding's anchor snippet against
// the audited files and the registered deep-read callers, at write time.
// A snippet that does not resolve uniquely is refused or downgraded and
// recorded in the report header — never silently shipped.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { parseReportFindings, resolveAnchors } from './lib/anchors.js';
import { readCallersFile, readPlanFile } from './lib/read-json.js';
import { AUDIT_READ_MAX_BYTES, readGuarded } from './lib/safe-read.js';

export const checkAnchorsCommand: CommandModule = {
  command: 'check-anchors',
  describe:
    'Resolve the anchor snippets of a report draft against the audited files and registered callers',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Plan JSON written by `qwen audit plan-files`',
      })
      .option('report', {
        type: 'string',
        demandOption: true,
        describe: 'The report draft whose findings are resolved',
      })
      .option('callers', {
        type: 'string',
        describe: 'JSON array of registered deep-read caller absolute paths',
      }),
  handler: (argv) => {
    const { plan, report, callers } = argv as unknown as {
      plan: string;
      report: string;
      callers?: string;
    };
    const planJson = readPlanFile(plan, 'check-anchors');
    const registeredCallers = callers
      ? readCallersFile(callers, 'check-anchors')
      : [];
    // Guarded read: the report draft is agent-authored — a writer-less
    // FIFO must not hang the write gate.
    const reportContent = readGuarded(report, AUDIT_READ_MAX_BYTES);
    if (reportContent === null) {
      throw new Error(
        `audit check-anchors: cannot read ${report} — missing, unreadable, not a regular file, or oversized.`,
      );
    }
    const reportText = reportContent.toString('utf8');
    const findings = parseReportFindings(reportText);
    const results = resolveAnchors(findings, planJson, registeredCallers);
    writeStdoutLine(JSON.stringify(results, null, 2));
    if (results.some((r) => r.verdict !== 'resolved')) {
      process.exitCode = 4;
    }
  },
};
