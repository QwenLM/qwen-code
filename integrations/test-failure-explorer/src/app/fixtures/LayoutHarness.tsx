/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRoot } from 'react-dom/client';
import type {
  ItemHeader,
  ListData,
  QueryData,
  ReportQuery,
  ShowData,
} from '../../app-contract.js';
import { ReportApp } from '../App.js';
import '../styles.css';

const reportId = `r1_${'a'.repeat(64)}`;
const items: ItemHeader[] = Array.from({ length: 26 }, (_, index) => ({
  itemId: `f0:a${index}`,
  kind: 'assertion',
  status: 'failed',
  path: { text: 'tests/report-layout.test.ts', truncated: false },
  title: {
    text: `Failure ${index}: expected the report evidence to remain accessible`,
    truncated: false,
  },
  duration: 12,
  location: { line: 9, column: 3 },
  diagnosticsAvailable: true,
}));

function list(offset = 0): ListData {
  const page = items.slice(offset, offset + 25);
  return {
    protocolVersion: 1,
    reportId,
    kind: 'list',
    collection: 'failures',
    searchScope: 'whole-snapshot/path/title/diagnostics',
    matchedCount: items.length,
    returnedCount: page.length,
    offset,
    nextOffset:
      offset + page.length < items.length ? offset + page.length : null,
    items: page,
  };
}

const report: ShowData = {
  protocolVersion: 1,
  reportId,
  kind: 'show',
  viewResolution: { mode: 'fixed' },
  summary: {
    adapter: { name: 'vitest-json-3.2', version: 1 },
    source: {
      relativePath: { text: 'reports/vitest.json', truncated: false },
      sha256: 'b'.repeat(64),
      bytes: 12_000,
    },
    importedAt: '2026-10-11T14:00:00.000Z',
    provenance: {
      kind: 'report-only',
      processExitCode: 'unknown',
      runCompleteness: 'unknown',
      testedCommit: 'unknown',
      unhandledErrors: 'unavailable',
    },
    reported: {
      numTotalTestSuites: 3,
      numPassedTestSuites: 1,
      numFailedTestSuites: 2,
      numPendingTestSuites: 0,
      numTotalTests: 30,
      numPassedTests: 4,
      numFailedTests: 26,
      numPendingTests: 0,
      numTodoTests: 0,
      startTime: 1,
      success: false,
    },
    computed: {
      fileEntries: 1,
      passedFiles: 0,
      failedFiles: 1,
      assertions: 26,
      statuses: {
        passed: 0,
        failed: 26,
        skipped: 0,
        pending: 0,
        todo: 0,
        disabled: 0,
      },
      fileErrors: 0,
      failures: 26,
    },
    consistencyWarnings: Array.from({ length: 8 }, (_, index) => ({
      text: `Reported count ${index} differs from the computed report entries.`,
      truncated: false,
    })),
    consistencyWarningCount: 8,
    limits: { resultChars: 24_000, pageItems: 50, detailChars: 8_000 },
  },
  firstPage: list(),
};

const diagnostics = Array.from(
  { length: 40 },
  (_, index) => `Diagnostic line ${index}: expected accessible evidence.\n`,
).join('');

async function query(request: ReportQuery): Promise<QueryData> {
  if (request.kind === 'list') return list(request.offset);
  if (request.kind !== 'detail')
    throw new Error('Unexpected layout fixture query');
  const offset = request.offset ?? 0;
  const text = diagnostics.slice(offset, offset + 400);
  return {
    protocolVersion: 1,
    reportId,
    kind: 'detail',
    item: items.find((item) => item.itemId === request.itemId)!,
    field: request.field ?? 'diagnostics',
    textRepresentation: 'terminal-safe',
    offset,
    text,
    totalLength: diagnostics.length,
    nextOffset:
      offset + text.length < diagnostics.length ? offset + text.length : null,
  };
}

createRoot(document.getElementById('root')!).render(
  <ReportApp
    report={report}
    query={query}
    connectionNotice="The connection was interrupted. Saved evidence is retained while the host reconnects."
  />,
);
