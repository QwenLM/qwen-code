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
import { readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import type { FilesPlan } from './lib/files-plan.js';
import { parseReportFindings, resolveAnchors } from './lib/anchors.js';

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
    const planJson = JSON.parse(readFileSync(plan, 'utf8')) as FilesPlan;
    const registeredCallers = callers
      ? (JSON.parse(readFileSync(callers, 'utf8')) as string[])
      : [];
    const findings = parseReportFindings(readFileSync(report, 'utf8'));
    const results = resolveAnchors(findings, planJson, registeredCallers);
    writeStdoutLine(JSON.stringify(results, null, 2));
    if (results.some((r) => r.verdict !== 'resolved')) {
      process.exitCode = 4;
    }
  },
};
