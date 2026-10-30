/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  ADAPTER,
  ExplorerError,
  MAX_ASSERTIONS,
  MAX_FILES,
  PROVENANCE,
  reportedSchema,
  testStatusSchema,
  type NormalizedReport,
  type ReportItem,
} from './contracts.js';

function failFastArray<T>(element: z.ZodType<T, z.ZodTypeDef, unknown>) {
  return z.unknown().transform((value, ctx): T[] => {
    if (!Array.isArray(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected an array.',
      });
      return z.NEVER;
    }
    const entries: T[] = [];
    for (const entry of value) {
      const result = element.safeParse(entry);
      if (!result.success) {
        ctx.addIssue(result.error.issues[0]);
        return z.NEVER;
      }
      entries.push(result.data);
    }
    return entries;
  });
}

const optionalTime = z.number().finite().nonnegative().nullish();
const assertionSchema = z.object({
  ancestorTitles: failFastArray(z.string()),
  fullName: z.string(),
  title: z.string(),
  status: testStatusSchema,
  failureMessages: failFastArray(z.string()).nullable(),
  duration: optionalTime,
  location: z
    .object({
      line: z.number().int().nonnegative().safe(),
      column: z.number().int().nonnegative().safe(),
    })
    .nullish(),
});
const sourceSchema = reportedSchema
  .extend({
    testResults: failFastArray(
      z.object({
        name: z.string(),
        status: z.enum(['passed', 'failed']),
        message: z.string(),
        startTime: z.number().finite().nonnegative(),
        endTime: z.number().finite().nonnegative(),
        assertionResults: failFastArray(assertionSchema),
      }),
    ),
  })
  .strip();

function checkCollectionLimits(value: unknown): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('testResults' in value) ||
    !Array.isArray(value.testResults)
  ) {
    return;
  }
  let assertions = 0;
  if (
    value.testResults.length > MAX_FILES ||
    value.testResults.some((file: unknown) => {
      if (
        file !== null &&
        typeof file === 'object' &&
        'assertionResults' in file &&
        Array.isArray(file.assertionResults)
      ) {
        assertions += file.assertionResults.length;
      }
      return assertions > MAX_ASSERTIONS;
    })
  ) {
    throw new ExplorerError(
      'REPORT_TOO_LARGE',
      `Reports support at most ${MAX_FILES} file entries and ${MAX_ASSERTIONS} assertions.`,
    );
  }
}

export function parseVitestReport(value: unknown): NormalizedReport {
  checkCollectionLimits(value);
  const result = sourceSchema.safeParse(value);
  if (!result.success) {
    throw new ExplorerError(
      'INVALID_REPORT',
      'Expected a Vitest 3.2 JSON report with valid counters, files, and assertions.',
    );
  }
  const { testResults, ...reported } = result.data;
  const computed: NormalizedReport['computed'] = {
    fileEntries: testResults.length,
    passedFiles: 0,
    failedFiles: 0,
    assertions: 0,
    statuses: {
      passed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      todo: 0,
      disabled: 0,
    },
    fileErrors: 0,
    failures: 0,
  };
  const consistencyWarnings: string[] = [];
  const files = testResults.map((file, fileIndex) => {
    if (file.status === 'passed') computed.passedFiles++;
    else computed.failedFiles++;
    const items: ReportItem[] = file.assertionResults.map(
      (assertion, assertionIndex) => {
        computed.assertions++;
        computed.statuses[assertion.status]++;
        if (assertion.status === 'failed') computed.failures++;
        return {
          itemId: `f${fileIndex}:a${assertionIndex}`,
          kind: 'assertion',
          fileIndex,
          assertionIndex,
          path: file.name,
          title: assertion.title,
          fullName: assertion.fullName,
          status: assertion.status,
          diagnostics: assertion.failureMessages?.join('\n\n') ?? '',
          duration: assertion.duration ?? null,
          location: assertion.location ?? null,
        };
      },
    );
    const failedAssertions = items.some((item) => item.status === 'failed');
    if (
      file.message !== '' ||
      (file.status === 'failed' && !failedAssertions)
    ) {
      items.push({
        itemId: `f${fileIndex}:error`,
        kind: 'file-error',
        fileIndex,
        path: file.name,
        title: 'File-level diagnostic',
        fullName: 'File-level diagnostic',
        status: file.status,
        diagnostics: file.message,
        duration: null,
        location: null,
      });
      computed.fileErrors++;
      if (file.status === 'failed') computed.failures++;
    }
    if (file.status === 'passed' && (file.message !== '' || failedAssertions)) {
      consistencyWarnings.push(
        `File entry ${fileIndex} is passed but contains failure evidence.`,
      );
    }
    if (file.endTime < file.startTime) {
      consistencyWarnings.push(
        `File entry ${fileIndex} ends before its reported start time.`,
      );
    }
    return {
      fileIndex,
      path: file.name,
      status: file.status,
      startTime: file.startTime,
      endTime: file.endTime,
      items,
    };
  });
  const comparable = {
    numTotalTests: computed.assertions,
    numPassedTests: computed.statuses.passed,
    numFailedTests: computed.statuses.failed,
    numTodoTests: computed.statuses.todo,
  };
  for (const key of Object.keys(comparable) as Array<keyof typeof comparable>) {
    if (reported[key] !== comparable[key]) {
      consistencyWarnings.push(
        `${key} reports ${reported[key]} but entries contain ${comparable[key]}.`,
      );
    }
  }
  // Pending totals include skipped and unfinished tests, not only skipped tests.
  if (computed.statuses.disabled === 0) {
    const pending = computed.statuses.pending + computed.statuses.skipped;
    if (reported.numPendingTests !== pending) {
      consistencyWarnings.push(
        `numPendingTests reports ${reported.numPendingTests} but pending/skipped entries contain ${pending}.`,
      );
    }
  }
  if (reported.success && computed.failures > 0) {
    consistencyWarnings.push('Report success is true despite failure entries.');
  }
  return {
    adapter: ADAPTER,
    provenance: PROVENANCE,
    reported,
    computed,
    consistencyWarnings,
    files,
  };
}
