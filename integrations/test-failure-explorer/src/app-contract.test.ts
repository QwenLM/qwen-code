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
  const view = {
    schemaVersion: 1,
    reportId: snapshot.reportId,
    sections: [
      {
        kind: 'failure-list',
        groupBy: 'none',
        columns: ['title'],
        initialTextFilter: 'does not match',
      },
      { kind: 'evidence', initialFailureId: 'f0:a1' },
    ],
  };

  it('restores the effective generated layout and canonical evidence', () => {
    const data = showSchema.parse(showResult(snapshot, view).structuredContent);
    expect(data.view).toEqual(view);
    expect(data.viewResolution).toMatchObject({
      mode: 'generated',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(data.firstPage?.matchedCount).toBe(0);
    expect(data.initialDetail).toMatchObject({
      reportId: snapshot.reportId,
      item: { itemId: 'f0:a1', status: 'failed' },
      field: 'diagnostics',
      offset: 0,
    });
  });

  it.each([
    { ...view, schemaVersion: 2 },
    { ...view, reportId: `r1_${'b'.repeat(64)}` },
    { ...view, sections: [{ kind: 'html', html: '<script>run()</script>' }] },
  ])(
    'falls back without treating a saved filtered page as all failures',
    (invalid) => {
      const generated = showResult(snapshot, view).structuredContent!;
      const data = showSchema.parse({ ...generated, view: invalid });
      expect(data.viewResolution).toEqual({
        mode: 'fixed',
        reason: 'unsupported-view',
      });
      expect(data.summary).toEqual(generated['summary']);
      expect(data.firstPage).toBeUndefined();
      expect(data.initialDetail).toBeUndefined();
      expect(data.view).toBeUndefined();
    },
  );

  it('does not restore a rejected candidate or an unrelated saved detail', () => {
    const fixed = showResult(snapshot).structuredContent!;
    expect(showSchema.parse({ ...fixed, view }).view).toBeUndefined();
    const generated = showResult(snapshot, view).structuredContent!;
    const otherDetail = queryReport(snapshot, {
      kind: 'detail',
      itemId: 'f0:a0',
    }).structuredContent;
    expect(
      showSchema.safeParse({ ...generated, initialDetail: otherDetail })
        .success,
    ).toBe(false);
    expect(
      showSchema.safeParse({
        ...generated,
        initialDetail: {
          ...(generated['initialDetail'] as object),
          reportId: `r1_${'b'.repeat(64)}`,
        },
      }).success,
    ).toBe(false);
  });

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
