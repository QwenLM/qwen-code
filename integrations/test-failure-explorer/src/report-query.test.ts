/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_RESULT_CHARS, type ReportSnapshot } from './contracts.js';
import { importResult, queryReport, showResult } from './report-query.js';
import { showSchema } from './app-contract.js';
import { parseVitestReport } from './vitest-report.js';
import { viewSpecSchema, type ViewSpecV1 } from './view-spec.js';

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
function generatedView(data: ReportSnapshot): ViewSpecV1 {
  return {
    schemaVersion: 1,
    reportId: data.reportId,
    sections: [
      {
        kind: 'failure-list',
        groupBy: 'file',
        columns: ['title', 'path'],
      },
    ],
  };
}

describe('bounded report queries', () => {
  it('returns the effective view, canonical digest, filtered first page and original evidence', () => {
    const data = snapshot(80, 'Original failure evidence');
    const before = JSON.stringify(data);
    const view = generatedView(data);
    view.sections = [
      { kind: 'evidence', initialFailureId: 'f0:a79' },
      {
        kind: 'failure-list',
        groupBy: 'none',
        columns: ['duration', 'title'],
        initialTextFilter: 'item 79',
      },
    ];
    const shown = payload(showResult(data, view));
    expect(shown).toMatchObject({
      kind: 'show',
      view,
      viewResolution: {
        mode: 'generated',
        digest: createHash('sha256')
          .update(JSON.stringify(viewSpecSchema.parse(view)))
          .digest('hex'),
      },
      firstPage: {
        matchedCount: 1,
        items: [{ itemId: 'f0:a79' }],
      },
      initialDetail: {
        reportId: data.reportId,
        kind: 'detail',
        item: { itemId: 'f0:a79' },
        field: 'diagnostics',
        offset: 0,
        text: 'Original failure evidence',
      },
    });
    expect(JSON.stringify(data)).toBe(before);
    expect(
      payload(
        showResult(data, {
          sections: view.sections.map((section) =>
            Object.fromEntries(Object.entries(section).reverse()),
          ),
          reportId: view.reportId,
          schemaVersion: 1,
        }),
      )['viewResolution'],
    ).toEqual(shown['viewResolution']);
    expect(
      payload(
        showResult(data, { ...view, sections: [...view.sections].reverse() }),
      )['viewResolution'],
    ).not.toEqual(shown['viewResolution']);
  });

  it.each([
    { candidate: null, reason: 'invalid-schema' },
    { candidate: { schemaVersion: 2 }, reason: 'unsupported-version' },
    { candidate: { sections: [{ kind: 'html' }] }, reason: 'invalid-schema' },
    {
      candidate: { ['x'.repeat(9_000)]: 'untrusted' },
      reason: 'spec-too-large',
    },
  ])(
    'keeps a bounded fixed view for invalid candidates: $reason',
    ({ candidate, reason }) => {
      const data = snapshot(1);
      const shown = payload(showResult(data, candidate));
      expect(shown).toMatchObject({
        viewResolution: { mode: 'fixed', reason },
        firstPage: { matchedCount: 1 },
      });
      expect(shown).not.toHaveProperty('view');
      expect(shown).not.toHaveProperty('initialDetail');
      expect(JSON.stringify(shown)).not.toContain('untrusted');
    },
  );

  it('rejects foreign, missing and nonfailed references without hiding the report', () => {
    const data = snapshot(2);
    data.files[0].items[0].status = 'passed';
    const view = generatedView(data);
    const candidates = [
      { ...view, reportId: `r1_${'b'.repeat(64)}` },
      ...['f0:a0', 'f0:a99'].flatMap((failureId) => [
        {
          ...view,
          sections: [
            ...view.sections,
            { kind: 'evidence', initialFailureId: failureId },
          ],
        },
        {
          ...view,
          sections: [
            ...view.sections,
            {
              kind: 'hypothesis-groups',
              groups: [
                {
                  label: 'Cause',
                  hypothesis: 'Possible cause',
                  failureIds: [failureId],
                },
              ],
            },
          ],
        },
      ]),
    ];
    for (const candidate of candidates) {
      expect(payload(showResult(data, candidate))).toMatchObject({
        viewResolution: { mode: 'fixed', reason: 'invalid-reference' },
        firstPage: { matchedCount: 1, items: [{ itemId: 'f0:a1' }] },
      });
    }
  });

  it('retains generated layout while dropping optional initial detail before the page', () => {
    const data = snapshot(5, '"\\'.repeat(8_000));
    data.consistencyWarnings = Array.from({ length: 8 }, () => 'w'.repeat(320));
    const view = generatedView(data);
    view.sections.push({ kind: 'evidence', initialFailureId: 'f0:a0' });
    const shown = payload(showResult(data, view));
    expect(shown).toMatchObject({
      viewResolution: { mode: 'generated' },
      view,
    });
    expect(shown).toHaveProperty('firstPage');
    expect(shown).not.toHaveProperty('initialDetail');
  });

  it('drops an oversized initial page, then falls back if even the generated envelope exceeds the result budget', () => {
    const data = snapshot(5);
    data.source.relativePath = '"\\'.repeat(2_000);
    data.consistencyWarnings = Array.from({ length: 8 }, () =>
      '"\\'.repeat(1_000),
    );
    for (const item of data.files[0].items) {
      item.path = '"\\'.repeat(2_000);
      item.fullName = '"\\'.repeat(2_000);
    }
    const view = generatedView(data);
    const compact = payload(showResult(data, view));
    expect(compact).toMatchObject({
      viewResolution: { mode: 'generated' },
      view,
    });
    expect(compact).not.toHaveProperty('firstPage');
    view.sections.push({
      kind: 'hypothesis-groups',
      groups: Array.from({ length: 8 }, () => ({
        label: 'x'.repeat(120),
        hypothesis: '"'.repeat(300),
        failureIds: ['f0:a0'],
      })),
    });
    expect(viewSpecSchema.safeParse(view).success).toBe(true);
    const fallback = payload(showResult(data, view));
    expect(fallback).toMatchObject({
      viewResolution: { mode: 'fixed', reason: 'result-too-large' },
    });
    expect(fallback).not.toHaveProperty('view');
  });

  it('intersects failure IDs with filters and preserves canonical order and pagination', () => {
    const data = snapshot(150);
    const failureIds = Array.from(
      { length: 128 },
      (_, index) => `f0:a${127 - index}`,
    );
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = payload(
        queryReport(data, {
          kind: 'list',
          collection: 'failures',
          failureIds,
          offset,
          limit: 50,
        }),
      );
      expect(page['matchedCount']).toBe(128);
      ids.push(
        ...(page['items'] as Array<{ itemId: string }>).map(
          (item) => item.itemId,
        ),
      );
      offset = page['nextOffset'] as number | null;
    }
    expect(ids).toEqual([...failureIds].reverse());
    expect(
      payload(
        queryReport(data, {
          kind: 'list',
          collection: 'assertions',
          failureIds,
          text: 'item 127',
          status: 'failed',
        }),
      ),
    ).toMatchObject({ matchedCount: 1, items: [{ itemId: 'f0:a127' }] });
    expect(
      payload(
        queryReport(data, {
          kind: 'list',
          collection: 'file-errors',
          failureIds,
        }),
      ),
    ).toMatchObject({ matchedCount: 0 });
  });

  it.each(
    [
      [],
      ['f0:a0', 'f0:a0'],
      ['f0:a999'],
      ['f0:a1'],
      ['f0:a0', 'f0:a1'],
      Array.from({ length: 129 }, (_, index) => `f0:a${index}`),
    ].map((failureIds) => ({ failureIds })),
  )(
    'rejects invalid failure filters instead of silently omitting IDs: %j',
    ({ failureIds }) => {
      const data = snapshot(150);
      data.files[0].items[1].status = 'passed';
      expect(() =>
        queryReport(data, {
          kind: 'list',
          collection: 'failures',
          failureIds,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
    },
  );

  it('shows a fixed view and falls back to a bounded summary when escaped fields exceed the initial page budget', () => {
    const data = snapshot(5);
    data.source.relativePath = '"\\'.repeat(2000);
    data.consistencyWarnings = Array.from({ length: 8 }, () =>
      '"\\'.repeat(1000),
    );
    for (const item of data.files[0].items) {
      item.path = '"\\'.repeat(2000);
      item.fullName = '"\\'.repeat(2000);
    }
    const shown = payload(showResult(data));
    expect(showSchema.safeParse(shown).success).toBe(true);
    expect(shown).toMatchObject({
      kind: 'show',
      viewResolution: { mode: 'fixed' },
    });
    expect(shown).not.toHaveProperty('firstPage');
    expect(shown['summary']).toEqual(payload(importResult(data))['summary']);
  });

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
    const view = generatedView(data);
    view.sections.push({ kind: 'evidence', initialFailureId: 'f0:error' });
    expect(payload(showResult(data, view))).toMatchObject({
      viewResolution: { mode: 'generated' },
      initialDetail: { item: { itemId: 'f0:error', kind: 'file-error' } },
    });
    expect(
      payload(
        queryReport(data, {
          kind: 'list',
          collection: 'failures',
          failureIds: ['f0:error'],
        }),
      ),
    ).toMatchObject({ matchedCount: 1 });
    expect(
      payload(
        queryReport(data, {
          kind: 'list',
          collection: 'assertions',
          failureIds: ['f0:error'],
        }),
      ),
    ).toMatchObject({ matchedCount: 0 });
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
    const shown = payload(showResult(data));
    expect(showSchema.safeParse(shown).success).toBe(true);
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
    const shown = payload(showResult(data));
    expect(showSchema.safeParse(shown).success).toBe(true);
  });
});
