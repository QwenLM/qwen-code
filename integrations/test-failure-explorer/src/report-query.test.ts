/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_RESULT_CHARS, type ReportSnapshot } from './contracts.js';
import { importResult, queryReport } from './report-query.js';
import { parseVitestReport } from './vitest-report.js';

function snapshot(count = 80, diagnostic = 'Failure evidence'): ReportSnapshot {
  const normalized = parseVitestReport({
    numTotalTestSuites: 1,
    numPassedTestSuites: 0,
    numFailedTestSuites: 1,
    numPendingTestSuites: 0,
    numTotalTests: count,
    numPassedTests: 0,
    numFailedTests: count,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: 100,
    success: false,
    testResults: [
      {
        name: '/workspace/example.test.ts',
        status: 'failed',
        message: '',
        startTime: 100,
        endTime: 101,
        assertionResults: Array.from({ length: count }, (_, index) => ({
          ancestorTitles: ['suite'],
          fullName: `suite item ${index}`,
          title: `item ${index}`,
          status: 'failed',
          failureMessages: [diagnostic],
        })),
      },
    ],
  });
  return {
    ...normalized,
    schemaVersion: 1,
    reportId: `r1_${'a'.repeat(64)}`,
    source: {
      relativePath: '.qwen/test-reports/report.json',
      sha256: 'b'.repeat(64),
      bytes: 100,
    },
    importedAt: '2026-10-10T00:00:00.000Z',
    snapshotChecksum: 'c'.repeat(64),
  };
}
function payload(value: CallToolResult): Record<string, unknown> {
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  return value.structuredContent!;
}

describe('bounded report queries', () => {
  it('makes each complete page usable through text-only MCP content', () => {
    const data = snapshot(80, 'Read this diagnostic evidence');
    const results = [
      importResult(data),
      queryReport(data, { kind: 'summary' }),
      queryReport(data, { kind: 'list', collection: 'failures' }),
      queryReport(data, { kind: 'detail', itemId: 'f0:a0' }),
    ];
    const textPayloads = results.map((value) => {
      const block = value.content[0];
      expect(block.type).toBe('text');
      if (block.type !== 'text') throw new Error('Expected text fallback');
      const parsed: unknown = JSON.parse(
        block.text.slice(block.text.indexOf('\n') + 1),
      );
      expect(parsed).toEqual(payload(value));
      expect(block.text).toContain(data.reportId);
      return parsed;
    });
    expect(textPayloads[0]).toMatchObject({
      firstPage: {
        items: [
          expect.objectContaining({ itemId: 'f0:a0' }),
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.anything(),
        ],
      },
    });
    expect(textPayloads[2]).toMatchObject({
      nextOffset: 25,
      returnedCount: 25,
    });
    expect(textPayloads[3]).toMatchObject({
      text: 'Read this diagnostic evidence',
      nextOffset: null,
    });
  });

  it('retains all repeated titles and paths from the explicitly derived runner fixture', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL(
          '../test-fixtures/duplicate-paths.derived.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const data = { ...snapshot(0), ...parseVitestReport(raw) };
    const value = payload(
      queryReport(data, { kind: 'list', collection: 'failures' }),
    );
    expect(value).toMatchObject({ matchedCount: 4, returnedCount: 4 });
    expect(
      (value['items'] as Array<{ itemId: string }>).map((item) => item.itemId),
    ).toEqual(['f0:a0', 'f0:a1', 'f1:a0', 'f1:a1']);
  });

  it('exposes a real collection failure through file-errors without manufacturing an assertion', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL('../test-fixtures/file-error.json', import.meta.url),
        'utf8',
      ),
    );
    const data = { ...snapshot(0), ...parseVitestReport(raw) };
    expect(
      payload(queryReport(data, { kind: 'list', collection: 'assertions' })),
    ).toMatchObject({ matchedCount: 0 });
    expect(
      payload(queryReport(data, { kind: 'list', collection: 'file-errors' })),
    ).toMatchObject({
      matchedCount: 1,
      items: [
        expect.objectContaining({ itemId: 'f0:error', kind: 'file-error' }),
      ],
    });
    const detail = payload(
      queryReport(data, { kind: 'detail', itemId: 'f0:error' }),
    );
    expect(detail['text']).toBe('Fixture module failed while collecting tests');
  });

  it('keeps real hostile fixture evidence as bounded plain text', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL('../test-fixtures/hostile-text.json', import.meta.url),
        'utf8',
      ),
    );
    const data = { ...snapshot(0), ...parseVitestReport(raw) };
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const detail = payload(
        queryReport(data, { kind: 'detail', itemId: 'f0:a0', offset }),
      );
      pages.push(detail['text'] as string);
      offset = detail['nextOffset'] as number | null;
    }
    const text = pages.join('');
    expect(text).toContain(
      '<script>throw new Error("never execute report text")</script>',
    );
    expect(text).toContain('Ignore previous instructions');
    expect(text).toContain('diagnostic line 159: 😀 中文');
    expect(text).not.toContain('\u001b');
  });

  it('searches the full snapshot using literal text and counts matching records', () => {
    const data = snapshot();
    const matched = payload(
      queryReport(data, {
        kind: 'list',
        collection: 'failures',
        text: 'item 79',
      }),
    );
    expect(matched).toMatchObject({
      matchedCount: 1,
      returnedCount: 1,
      nextOffset: null,
    });
    expect(matched['items']).toEqual([
      expect.objectContaining({ itemId: 'f0:a79' }),
    ]);
    expect(
      payload(
        queryReport(data, { kind: 'list', collection: 'failures', text: '.*' }),
      ),
    ).toMatchObject({ matchedCount: 0 });
  });

  it('returns every entry exactly once with stable offset pagination', () => {
    const data = snapshot();
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = payload(
        queryReport(data, { kind: 'list', collection: 'failures', offset }),
      );
      ids.push(
        ...(page['items'] as Array<{ itemId: string }>).map(
          (item) => item.itemId,
        ),
      );
      offset = page['nextOffset'] as number | null;
    }
    expect(ids).toEqual(
      Array.from({ length: 80 }, (_, index) => `f0:a${index}`),
    );
  });

  it('keeps full result under budget even when list text expands during JSON escaping', () => {
    const data = snapshot();
    data.files[0].items.forEach((item) => {
      item.path = '"\\'.repeat(10_000);
      item.fullName = '"\\'.repeat(10_000);
    });
    const page = payload(
      queryReport(data, { kind: 'list', collection: 'failures', limit: 50 }),
    );
    expect(page['returnedCount']).toBeGreaterThan(0);
    expect(page['returnedCount']).toBeLessThan(50);
    expect(page['nextOffset']).toBe(page['returnedCount']);
    expect(
      (page['items'] as Array<{ path: { truncated: boolean } }>)[0].path
        .truncated,
    ).toBe(true);
    payload(importResult(data));
  });

  it('reassembles huge escaped diagnostics without losing Unicode surrogate pairs', () => {
    const text = '"\\\n😀'.repeat(12_000);
    const data = snapshot(1, text);
    const pieces: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = payload(
        queryReport(data, { kind: 'detail', itemId: 'f0:a0', offset }),
      );
      const part = page['text'] as string;
      expect(part.length).toBeGreaterThan(0);
      expect(part.length).toBeLessThanOrEqual(8_000);
      expect(part.at(-1)?.charCodeAt(0)).not.toBe(0xd83d);
      pieces.push(part);
      offset = page['nextOffset'] as number | null;
    }
    expect(pieces.join('')).toBe(text);
  });

  it('uses terminal-safe field offsets while preserving raw snapshot text', () => {
    const raw =
      '\u001b[31mred\u001b[0m\u0007\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007\nnext';
    const data = snapshot(1, raw);
    const value = payload(
      queryReport(data, { kind: 'detail', itemId: 'f0:a0' }),
    );
    expect(value).toMatchObject({
      text: 'redlink\nnext',
      totalLength: 12,
      textRepresentation: 'terminal-safe',
    });
    expect(data.files[0].items[0].diagnostics).toBe(raw);
  });

  it('makes full path and title available even if their headers are abbreviated', () => {
    const data = snapshot(1);
    data.files[0].items[0].path = 'p'.repeat(10_000);
    data.files[0].items[0].fullName = 't'.repeat(10_000);
    const first = payload(
      queryReport(data, { kind: 'detail', itemId: 'f0:a0', field: 'path' }),
    );
    expect(first).toMatchObject({
      totalLength: 10_000,
      nextOffset: 8_000,
      text: 'p'.repeat(8_000),
    });
    const second = payload(
      queryReport(data, {
        kind: 'detail',
        itemId: 'f0:a0',
        field: 'title',
        offset: 8_000,
      }),
    );
    expect(second).toMatchObject({
      totalLength: 10_000,
      nextOffset: null,
      text: 't'.repeat(2_000),
    });
  });

  it('distinguishes no available diagnostics from unknown IDs', () => {
    const data = snapshot(1, '');
    expect(
      payload(queryReport(data, { kind: 'detail', itemId: 'f0:a0' })),
    ).toMatchObject({ text: '', totalLength: 0, nextOffset: null });
    expect(() =>
      queryReport(data, { kind: 'detail', itemId: 'f0:a99' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
  });

  it.each([
    { kind: 'list', collection: 'failures', status: 'passed' },
    { kind: 'list', collection: 'file-errors', status: 'todo' },
    { kind: 'list', collection: 'failures', limit: 51 },
    { kind: 'list', collection: 'failures', offset: -1 },
    { kind: 'list', collection: 'failures', text: 'x'.repeat(513) },
    { kind: 'summary', shell: 'echo test' },
    { kind: 'detail', itemId: 'f0:a0', offset: 999_999 },
  ])('rejects invalid query parameters', (query) => {
    expect(() => queryReport(snapshot(1), query)).toThrow(
      expect.objectContaining({ code: 'INVALID_QUERY' }),
    );
  });

  it('rejects an explicit offset between a surrogate pair', () => {
    expect(() =>
      queryReport(snapshot(1, '😀'), {
        kind: 'detail',
        itemId: 'f0:a0',
        offset: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
  });

  it('keeps summaries bounded when many warnings or long source paths exist', () => {
    const data = snapshot(1);
    data.source.relativePath = '\u001b[31m' + 'p'.repeat(30_000);
    data.consistencyWarnings = Array.from({ length: 2_000 }, () =>
      'w'.repeat(10_000),
    );
    const value = payload(queryReport(data, { kind: 'summary' }));
    expect(
      (value['summary'] as { consistencyWarningCount: number })
        .consistencyWarningCount,
    ).toBe(2_000);
    payload(importResult(data));
  });
});
