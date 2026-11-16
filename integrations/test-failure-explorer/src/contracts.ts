/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 2_000;
export const MAX_ASSERTIONS = 20_000;
export const MAX_RESULT_CHARS = 24_000;
export const MAX_DETAIL_CHARS = 8_000;
export const REPORT_ID_PATTERN = /^r1_[0-9a-f]{64}$/;
export const ADAPTER = { name: 'vitest-json-3.2', version: 1 } as const;
export const PROVENANCE = {
  kind: 'report-only',
  processExitCode: 'unknown',
  runCompleteness: 'unknown',
  unhandledErrors: 'unavailable',
  testedCommit: 'unknown',
} as const;

export type ExplorerErrorCode =
  | 'INVALID_REPORT'
  | 'REPORT_TOO_LARGE'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'REPORT_UNAVAILABLE'
  | 'INVALID_QUERY'
  | 'STORAGE_ERROR';

export class ExplorerError extends Error {
  constructor(
    readonly code: ExplorerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExplorerError';
  }
}

export const testStatusSchema = z.enum([
  'passed',
  'failed',
  'skipped',
  'pending',
  'todo',
  'disabled',
]);
export type TestStatus = z.infer<typeof testStatusSchema>;
const count = z.number().int().nonnegative().safe();
const time = z.number().finite().nonnegative();
const locationSchema = z
  .object({ line: count, column: count })
  .strict()
  .nullable();

export const reportedSchema = z
  .object({
    numTotalTestSuites: count,
    numPassedTestSuites: count,
    numFailedTestSuites: count,
    numPendingTestSuites: count,
    numTotalTests: count,
    numPassedTests: count,
    numFailedTests: count,
    numPendingTests: count,
    numTodoTests: count,
    startTime: time,
    success: z.boolean(),
  })
  .strict();

export const reportItemSchema = z
  .object({
    itemId: z.string().regex(/^f\d+:(?:a\d+|error)$/),
    kind: z.enum(['assertion', 'file-error']),
    fileIndex: count,
    assertionIndex: count.optional(),
    path: z.string(),
    title: z.string(),
    fullName: z.string(),
    status: testStatusSchema,
    diagnostics: z.string(),
    duration: time.nullable(),
    location: locationSchema,
  })
  .strict();
export type ReportItem = z.infer<typeof reportItemSchema>;

export const normalizedReportSchema = z
  .object({
    adapter: z
      .object({ name: z.literal(ADAPTER.name), version: z.literal(1) })
      .strict(),
    provenance: z
      .object({
        kind: z.literal('report-only'),
        processExitCode: z.literal('unknown'),
        runCompleteness: z.literal('unknown'),
        unhandledErrors: z.literal('unavailable'),
        testedCommit: z.literal('unknown'),
      })
      .strict(),
    reported: reportedSchema,
    computed: z
      .object({
        fileEntries: count,
        passedFiles: count,
        failedFiles: count,
        assertions: count.max(MAX_ASSERTIONS),
        statuses: z
          .object({
            passed: count,
            failed: count,
            skipped: count,
            pending: count,
            todo: count,
            disabled: count,
          })
          .strict(),
        fileErrors: count,
        failures: count,
      })
      .strict(),
    consistencyWarnings: z.array(z.string()),
    files: z
      .array(
        z
          .object({
            fileIndex: count,
            path: z.string(),
            status: z.enum(['passed', 'failed']),
            startTime: time,
            endTime: time,
            items: z.array(reportItemSchema).max(MAX_ASSERTIONS + 1),
          })
          .strict(),
      )
      .max(MAX_FILES),
  })
  .strict();
export type NormalizedReport = z.infer<typeof normalizedReportSchema>;

export const reportSnapshotSchema = normalizedReportSchema
  .extend({
    schemaVersion: z.literal(1),
    reportId: z.string().regex(REPORT_ID_PATTERN),
    source: z
      .object({
        relativePath: z.string(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: count.max(MAX_SOURCE_BYTES),
      })
      .strict(),
    importedAt: z.string().datetime(),
    snapshotChecksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;
