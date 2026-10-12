/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readQueryData, readToolData, showSchema } from './app-contract.js';
import { queryReport, showResult } from './report-query.js';
import { parseVitestReport } from './vitest-report.js';
import type { ReportSnapshot } from './contracts.js';

const snapshot: ReportSnapshot = {
  ...parseVitestReport(
    JSON.parse(
      readFileSync(
        new URL('../test-fixtures/mixed.json', import.meta.url),
        'utf8',
      ),
    ),
  ),
  schemaVersion: 1,
  reportId: `r1_${'a'.repeat(64)}`,
  source: { relativePath: 'report.json', sha256: 'b'.repeat(64), bytes: 100 },
  importedAt: '2026-10-11T00:00:00.000Z',
  snapshotChecksum: 'c'.repeat(64),
};

describe('App report contract', () => {
  it('accepts the actual server envelope and rejects a foreign initial page or protocol', () => {
    const data = showResult(snapshot).structuredContent!;
    expect(showSchema.safeParse(data).success).toBe(true);
    expect(showSchema.safeParse({ ...data, protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(
      showSchema.safeParse({
        ...data,
        firstPage: {
          ...(data['firstPage'] as object),
          reportId: `r1_${'b'.repeat(64)}`,
        },
      }).success,
    ).toBe(false);
  });

  it('matches query results to the report, collection and requested page', () => {
    const query = {
      kind: 'list',
      collection: 'assertions',
      offset: 2,
    } as const;
    const data = queryReport(snapshot, query).structuredContent;
    expect(readQueryData(data, snapshot.reportId, query)).toMatchObject({
      offset: 2,
    });
    expect(() => readQueryData(data, `r1_${'b'.repeat(64)}`, query)).toThrow(
      'does not match',
    );
    expect(() =>
      readQueryData(data, snapshot.reportId, { ...query, offset: 0 }),
    ).toThrow('does not match');
    expect(() =>
      readQueryData(data, snapshot.reportId, {
        ...query,
        collection: 'failures',
      }),
    ).toThrow('does not match');
  });

  it('matches detail results to the exact item and field', () => {
    const query = { kind: 'detail', itemId: 'f0:a0', field: 'title' } as const;
    const data = queryReport(snapshot, query).structuredContent;
    expect(readQueryData(data, snapshot.reportId, query)).toMatchObject({
      field: 'title',
    });
    expect(() =>
      readQueryData(data, snapshot.reportId, { ...query, itemId: 'f0:a1' }),
    ).toThrow('does not match');
    expect(() =>
      readQueryData(data, snapshot.reportId, { ...query, field: 'path' }),
    ).toThrow('does not match');
    expect(() =>
      readQueryData(data, snapshot.reportId, { ...query, offset: 1 }),
    ).toThrow('does not match');
  });

  it('distinguishes unavailable snapshots and invalid responses from empty reports', () => {
    expect(() =>
      readToolData({
        isError: true,
        structuredContent: {
          code: 'REPORT_UNAVAILABLE',
          message: 'Snapshot is unavailable.',
        },
      }),
    ).toThrow('REPORT_UNAVAILABLE');
    expect(() => readToolData({ isError: true })).toThrow(
      'Report query failed',
    );
    expect(() =>
      readQueryData({}, snapshot.reportId, { kind: 'summary' }),
    ).toThrow('invalid report response');
  });
});
