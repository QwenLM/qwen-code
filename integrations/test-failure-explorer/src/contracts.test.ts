/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reportSnapshotSchema } from './contracts.js';
import { parseVitestReport } from './vitest-report.js';

function persistedSnapshot() {
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL('../test-fixtures/mixed.json', import.meta.url),
      'utf8',
    ),
  );
  return {
    ...parseVitestReport(raw),
    schemaVersion: 1,
    reportId: `r1_${'a'.repeat(64)}`,
    source: {
      relativePath: '.qwen/test-reports/mixed.json',
      sha256: 'b'.repeat(64),
      bytes: 100,
    },
    importedAt: '2026-10-10T00:00:00.000Z',
    snapshotChecksum: 'c'.repeat(64),
  };
}

describe('persisted snapshot contract', () => {
  it('validates a complete JSON roundtrip of normalized real report data', () => {
    const value = persistedSnapshot();
    const parsed = reportSnapshotSchema.parse(
      JSON.parse(JSON.stringify(value)),
    );
    expect(parsed).toEqual(value);
  });

  it.each([
    { schemaVersion: 2 },
    { adapter: { name: 'jest', version: 1 } },
    { reportId: '../outside.json' },
    { snapshotChecksum: 'not-a-sha256' },
    { provenance: { kind: 'report-only', processExitCode: 0 } },
    { importedAt: 'yesterday' },
    { unexpected: 'not a normalized product field' },
  ])('rejects unsupported or malformed cached state', (fields) => {
    expect(
      reportSnapshotSchema.safeParse({ ...persistedSnapshot(), ...fields })
        .success,
    ).toBe(false);
  });

  it('rejects unknown nested statuses instead of producing a successful empty cache', () => {
    const value = persistedSnapshot();
    const first = value.files[0].items[0];
    const malformed: unknown = {
      ...value,
      files: [{ ...value.files[0], items: [{ ...first, status: 'broken' }] }],
    };
    expect(reportSnapshotSchema.safeParse(malformed).success).toBe(false);
  });
});
