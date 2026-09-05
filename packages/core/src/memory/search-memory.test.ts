/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  executeSearchMemory,
  type ExecuteSearchMemoryOptions,
  type SearchMemoryToolResult,
} from './search-memory.js';
import { rereadAutoMemoryDocument } from './scan.js';
import type {
  AutoMemoryScanSnapshot,
  ScannedAutoMemoryDocument,
} from './scan.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    rereadAutoMemoryDocument: vi.fn(
      async (doc: ScannedAutoMemoryDocument) => doc,
    ),
  };
});

function doc(
  relativePath: string,
  overrides: Partial<ScannedAutoMemoryDocument> = {},
): ScannedAutoMemoryDocument {
  return {
    scope: 'project',
    type: 'project',
    filePath: `/tmp/memory/${relativePath}`,
    relativePath,
    filename: relativePath.split('/').at(-1) ?? relativePath,
    title: relativePath,
    description: '',
    category: 'project_introduction',
    keywords: [],
    usageScenarios: [],
    body: '',
    mtimeMs: 1,
    ...overrides,
  };
}

function snapshot(docs: ScannedAutoMemoryDocument[]): AutoMemoryScanSnapshot {
  return {
    docs,
    sourceStatus: {
      requestedScopes: ['project'],
      searchedScopes: ['project'],
      unavailableScopes: [],
      complete: true,
      incompleteScopes: [],
    },
  };
}

function options(
  docs: ScannedAutoMemoryDocument[],
): ExecuteSearchMemoryOptions {
  return {
    projectRoot: '/tmp/project',
    snapshot: snapshot(docs),
  };
}

function expectContentResult<M extends 'fetch' | 'search'>(
  result: SearchMemoryToolResult,
  mode: M,
): Extract<SearchMemoryToolResult, { mode: M }> {
  if (result.mode !== mode) {
    throw new Error(`expected ${mode} result`);
  }
  return result as Extract<SearchMemoryToolResult, { mode: M }>;
}

function expectExploreResult(
  result: SearchMemoryToolResult,
): Extract<SearchMemoryToolResult, { mode: 'explore' }> {
  if (result.mode !== 'explore') {
    throw new Error('expected explore result');
  }
  return result;
}

describe('executeSearchMemory', () => {
  it('reports privacy-safe execution timing and result counts', async () => {
    const onComplete = vi.fn();
    await executeSearchMemory(
      { mode: 'explore' },
      { ...options([doc('project/one.md')]), onComplete },
    );

    expect(onComplete).toHaveBeenCalledWith({
      mode: 'explore',
      docsScanned: 1,
      resultsReturned: 1,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(onComplete.mock.calls[0])).not.toMatch(
      /project\/one|keyword|content|memoryRef/,
    );
  });

  it('fetches exact refs without leaking metadata', async () => {
    const docs = [
      doc('project/tree.md', {
        title: 'Memory Tree',
        body: 'A'.repeat(1300),
      }),
    ];
    const result = await executeSearchMemory(
      { mode: 'fetch', refs: ['project:project/tree.md'] },
      options(docs),
    );

    const fetchResult = expectContentResult(result, 'fetch');
    expect(fetchResult.results).toHaveLength(1);
    expect(fetchResult.results[0]?.ref).toBe('project:project/tree.md');
    expect(fetchResult.results[0]?.version).toBe(1);
    expect(fetchResult.results[0]?.content).toHaveLength(1300);
    expect(fetchResult.results[0]?.truncated).toBe(false);
    expect(fetchResult.results[0]?.nextCursor).toBeUndefined();
    expect(fetchResult.results[0]?.range).toEqual({
      start: 0,
      end: 1300,
      total: 1300,
    });
    expect(fetchResult.results[0]).not.toHaveProperty('description');
    expect(fetchResult.results[0]).not.toHaveProperty('keywords');
    expect(fetchResult.results[0]).not.toHaveProperty('usageScenarios');
    expect(fetchResult.results[0]).not.toHaveProperty('category');
  });

  it('uses a lossless encoded ref for paths with prompt punctuation', async () => {
    const docs = [doc('project/a] b.md', { body: 'encoded body' })];
    const ref = 'project:project/a%5D%20b.md';

    const result = expectContentResult(
      await executeSearchMemory({ mode: 'fetch', refs: [ref] }, options(docs)),
      'fetch',
    );

    expect(result.results[0]?.ref).toBe(ref);
    expect(result.results[0]?.content).toBe('encoded body');
  });

  it('caps all bodies in one fetch call', async () => {
    const docs = Array.from({ length: 5 }, (_, index) =>
      doc(`project/${index}.md`, { body: String(index).repeat(10_000) }),
    );
    const bodyPresentVersions = new Map<string, number>();
    const fetchResult = expectContentResult(
      await executeSearchMemory(
        {
          mode: 'fetch',
          refs: docs.map((memory) => `project:${memory.relativePath}`),
        },
        { ...options(docs), bodyPresentVersions },
      ),
      'fetch',
    );

    expect(
      fetchResult.results.reduce(
        (total, result) => total + (result.content?.length ?? 0),
        0,
      ),
    ).toBe(20_000);
    expect(fetchResult.results).toHaveLength(3);
    expect(fetchResult.warnings).toEqual([
      'Skipped project:project/3.md: the aggregate fetch body budget is exhausted.',
      'Skipped project:project/4.md: the aggregate fetch body budget is exhausted.',
    ]);
    expect(bodyPresentVersions.size).toBe(0);
  });

  it('does not repeat a body that is still present in history', async () => {
    const docs = [doc('project/tree.md', { body: 'remembered body' })];
    const sharedOptions = {
      ...options(docs),
      bodyPresentVersions: new Map<string, number>(),
    };

    await executeSearchMemory(
      { mode: 'fetch', refs: ['project:project/tree.md'] },
      sharedOptions,
    );
    const repeated = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/tree.md'] },
        sharedOptions,
      ),
      'fetch',
    );

    expect(repeated.results[0]).toMatchObject({
      ref: 'project:project/tree.md',
      version: 1,
      alreadyAvailable: true,
    });
    expect(repeated.results[0]).not.toHaveProperty('content');
    expect(Object.keys(repeated.results[0] ?? {}).sort()).toEqual([
      'alreadyAvailable',
      'ref',
      'version',
    ]);
  });

  it('reports an exhausted but resident body as already available', async () => {
    const docs = [doc('project/tree.md', { body: 'remembered body' })];
    const exhaustedBodyRefs = new Set<string>();
    const sharedOptions = {
      ...options(docs),
      bodyPresentVersions: new Map<string, number>(),
      exhaustedBodyRefs,
    };
    await executeSearchMemory(
      { mode: 'fetch', refs: ['project:project/tree.md'] },
      sharedOptions,
    );
    exhaustedBodyRefs.add('project:project/tree.md');

    const repeated = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/tree.md'] },
        sharedOptions,
      ),
      'fetch',
    );

    expect(repeated.results[0]?.alreadyAvailable).toBe(true);
    expect(repeated.warnings).toBeUndefined();
  });

  it('reads a new version even when the previous body is still present', async () => {
    const memory = doc('project/tree.md', {
      body: 'old body',
      mtimeMs: 1,
    });
    const sharedOptions = {
      ...options([memory]),
      bodyPresentVersions: new Map<string, number>(),
    };
    await executeSearchMemory(
      { mode: 'fetch', refs: ['project:project/tree.md'] },
      sharedOptions,
    );
    memory.body = 'new body';
    memory.mtimeMs = 2;

    const refreshed = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/tree.md'] },
        sharedOptions,
      ),
      'fetch',
    );

    expect(refreshed.results[0]?.alreadyAvailable).toBeUndefined();
    expect(refreshed.results[0]?.content).toBe('new body');
  });

  it('lets cursor continuation reach the end of a memory body', async () => {
    const docs = [
      doc('project/long.md', {
        body: 'A'.repeat(6000),
      }),
    ];
    const result = await executeSearchMemory(
      { mode: 'fetch', refs: ['project:project/long.md'] },
      options(docs),
    );
    const fetchResult = expectContentResult(result, 'fetch');
    const last = fetchResult.results[0];

    expect(last?.range).toEqual({
      start: 0,
      end: 6000,
      total: 6000,
    });
    expect(last?.truncated).toBe(false);
    expect(last?.nextCursor).toBeUndefined();
    expect(last?.readLimitExhausted).toBeUndefined();
  });

  it('fetches the remaining body from a search cursor without restarting', async () => {
    const docs = [
      doc('project/continued.md', {
        keywords: ['cursor continuation'],
        body: 'cursor continuation '.repeat(300),
      }),
    ];
    const bodyPresentVersions = new Map<string, number>();
    const bodyCoverage = new Map();
    const testOptions = {
      ...options(docs),
      bodyPresentVersions,
      bodyCoverage,
    };
    const searchResult = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['cursor continuation'] },
        testOptions,
      ),
      'search',
    );
    const first = searchResult.results[0];

    expect(first?.range?.start).toBe(0);
    expect(first?.range?.end).toBe(1200);
    expect(first?.nextCursor).toEqual(expect.any(String));
    expect(first?.continuation).toEqual({
      mode: 'fetch',
      refs: ['project:project/continued.md'],
      cursor: first?.nextCursor,
    });

    const fetchResult = expectContentResult(
      await executeSearchMemory(
        {
          mode: 'fetch',
          refs: ['project:project/continued.md'],
          cursor: first?.nextCursor,
        },
        testOptions,
      ),
      'fetch',
    );

    expect(fetchResult.results[0]?.range).toEqual({
      start: 1200,
      end: 6000,
      total: 6000,
    });
    expect(fetchResult.results[0]?.truncated).toBe(false);
    expect(bodyPresentVersions).toEqual(
      new Map([['project:project/continued.md', 1]]),
    );

    const repeated = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/continued.md'] },
        testOptions,
      ),
      'fetch',
    );
    expect(repeated.results[0]?.alreadyAvailable).toBe(true);
  });

  it('does not mark a cursor tail as a complete resident body after earlier coverage is evicted', async () => {
    const docs = [
      doc('project/continued.md', {
        keywords: ['cursor continuation'],
        body: 'cursor continuation '.repeat(300),
      }),
    ];
    const bodyPresentVersions = new Map<string, number>();
    const bodyCoverage = new Map();
    const testOptions = {
      ...options(docs),
      bodyPresentVersions,
      bodyCoverage,
    };
    const searchResult = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['cursor continuation'] },
        testOptions,
      ),
      'search',
    );
    bodyCoverage.clear();

    await executeSearchMemory(
      {
        mode: 'fetch',
        refs: ['project:project/continued.md'],
        cursor: searchResult.results[0]?.nextCursor,
      },
      testOptions,
    );

    expect(bodyPresentVersions).toEqual(new Map());
    const repeated = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/continued.md'] },
        testOptions,
      ),
      'fetch',
    );
    expect(repeated.results[0]?.alreadyAvailable).toBeUndefined();
  });

  it('returns a new body window when a later search targets the same ref', async () => {
    const docs = [
      doc('project/continued.md', {
        keywords: ['first marker', 'second marker'],
        body: `first marker ${'A'.repeat(3000)} second marker`,
      }),
    ];
    const testOptions = {
      ...options(docs),
      bodyPresentVersions: new Map<string, number>(),
    };

    const first = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['first marker'] },
        testOptions,
      ),
      'search',
    );
    const second = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['second marker'] },
        testOptions,
      ),
      'search',
    );

    expect(first.results[0]?.content).toContain('first marker');
    expect(second.results[0]?.content).toContain('second marker');
    expect(second.results[0]?.alreadyAvailable).toBeUndefined();
    expect(second.results[0]?.range?.start).toBeGreaterThan(
      first.results[0]?.range?.start ?? 0,
    );
    expect(testOptions.bodyPresentVersions).toEqual(new Map());

    const fetched = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/continued.md'] },
        testOptions,
      ),
      'fetch',
    );
    expect(fetched.results[0]?.alreadyAvailable).toBeUndefined();
    expect(fetched.results[0]?.content).toContain('second marker');
  });

  it('does not repeat a fully resident body through search', async () => {
    const docs = [
      doc('project/resident.md', {
        keywords: ['resident body'],
        body: 'resident body details',
      }),
    ];
    const testOptions = {
      ...options(docs),
      bodyPresentVersions: new Map<string, number>(),
      bodyCoverage: new Map(),
    };

    await executeSearchMemory(
      { mode: 'fetch', refs: ['project:project/resident.md'] },
      testOptions,
    );
    const searched = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['resident body'] },
        testOptions,
      ),
      'search',
    );

    expect(searched.results[0]).toMatchObject({
      ref: 'project:project/resident.md',
      alreadyAvailable: true,
    });
    expect(searched.results[0]).not.toHaveProperty('content');
  });

  it('does not repeat an unchanged search window already in history', async () => {
    const docs = [
      doc('project/window.md', {
        keywords: ['window marker'],
        body: `prefix ${'A'.repeat(2000)} window marker suffix`,
      }),
    ];
    const testOptions = {
      ...options(docs),
      bodyPresentVersions: new Map<string, number>(),
      bodyCoverage: new Map(),
    };

    await executeSearchMemory(
      { mode: 'search', keywords: ['window marker'] },
      testOptions,
    );
    const repeated = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['window marker'] },
        testOptions,
      ),
      'search',
    );

    expect(repeated.results[0]?.alreadyAvailable).toBe(true);
    expect(repeated.results[0]).not.toHaveProperty('content');
  });

  it('returns a search window for a match after the aggregate result budget', async () => {
    const result = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['late marker'] },
        options([
          doc('project/late.md', {
            body: `${'A'.repeat(8000)} late marker`,
          }),
        ]),
      ),
      'search',
    );

    expect(result.results[0]?.content).toContain('late marker');
    expect(result.results[0]?.readLimitExhausted).toBeUndefined();
  });

  it('marks a ref exhausted only after the per-ref fetch budget is spent', async () => {
    const docs = [
      doc('project/long.md', {
        body: `${'A'.repeat(21000)} single-method orchestrator class`,
      }),
    ];
    const exhaustedBodyRefs = new Set<string>();
    const testOptions = {
      ...options(docs),
      exhaustedBodyRefs,
      bodyCoverage: new Map(),
    };

    const first = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/long.md'] },
        testOptions,
      ),
      'fetch',
    ).results[0];
    const second = expectContentResult(
      await executeSearchMemory(
        {
          mode: 'fetch',
          refs: ['project:project/long.md'],
          cursor: first?.nextCursor,
        },
        testOptions,
      ),
      'fetch',
    ).results[0];
    const last = expectContentResult(
      await executeSearchMemory(
        {
          mode: 'fetch',
          refs: ['project:project/long.md'],
          cursor: second?.nextCursor,
        },
        testOptions,
      ),
      'fetch',
    ).results[0];

    expect(last?.range).toEqual({ start: 16000, end: 20000, total: 21033 });
    expect(last?.truncated).toBe(true);
    expect(last?.nextCursor).toBeUndefined();
    expect(last?.readLimitExhausted).toBe(true);
    expect(exhaustedBodyRefs.has('project:project/long.md')).toBe(true);

    const searchResult = expectContentResult(
      await executeSearchMemory(
        {
          mode: 'search',
          keywords: ['orchestrator'],
        },
        testOptions,
      ),
      'search',
    );
    expect(searchResult.results).toEqual([]);
  });

  it('does not exhaust a ref after a short window near the read cap', async () => {
    const body = `early marker ${'A'.repeat(19_470)} late marker ${'B'.repeat(2000)}`;
    const exhaustedBodyRefs = new Set<string>();
    const testOptions = {
      ...options([doc('project/long.md', { body })]),
      exhaustedBodyRefs,
      bodyCoverage: new Map(),
    };

    const late = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['late marker'] },
        testOptions,
      ),
      'search',
    );
    const early = expectContentResult(
      await executeSearchMemory(
        { mode: 'search', keywords: ['early marker'] },
        testOptions,
      ),
      'search',
    );

    expect(late.results[0]?.content).toContain('late marker');
    expect(exhaustedBodyRefs).toEqual(new Set());
    expect(early.results[0]?.content).toContain('early marker');
  });

  it('does not return an empty result for a body match beyond the read budget', async () => {
    const result = await executeSearchMemory(
      { mode: 'search', keywords: ['tail-only-marker'] },
      options([
        doc('project/long.md', {
          body: `${'A'.repeat(20_001)}tail-only-marker`,
        }),
      ]),
    );

    expect(expectContentResult(result, 'search').results).toEqual([]);
  });

  it('does not let fetch restart an exhausted ref without a cursor', async () => {
    const docs = [
      doc('project/long.md', {
        body: 'A'.repeat(21000),
      }),
    ];
    const exhaustedBodyRefs = new Set<string>(['project:project/long.md']);
    const fetchResult = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/long.md'] },
        {
          ...options(docs),
          exhaustedBodyRefs,
        },
      ),
      'fetch',
    );

    expect(fetchResult.results).toEqual([]);
    expect(fetchResult.warnings).toEqual([
      'Skipped project:project/long.md: the per-ref fetch budget is already exhausted for this turn.',
    ]);
  });

  it('rejects fabricated memory cursors', async () => {
    const docs = [
      doc('project/long.md', {
        body: 'A'.repeat(6000),
      }),
    ];
    const forgedCursor = Buffer.from(
      JSON.stringify({
        kind: 'memory',
        ref: 'project:project/long.md',
        mtimeMs: 1,
        offset: 4800,
        depth: 4,
      }),
      'utf-8',
    ).toString('base64url');

    await expect(
      executeSearchMemory(
        {
          mode: 'fetch',
          refs: ['project:project/long.md'],
          cursor: forgedCursor,
        },
        options(docs),
      ),
    ).rejects.toThrow('Invalid cursor.');
  });

  it('rejects edited issued memory cursors', async () => {
    const docs = [
      doc('project/long.md', {
        keywords: ['issued cursor'],
        body: 'issued cursor '.repeat(3000),
      }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['issued cursor'],
      },
      options(docs),
    );
    const searchResult = expectContentResult(result, 'search');
    const issuedCursor = searchResult.results[0]?.nextCursor;
    expect(issuedCursor).toEqual(expect.any(String));
    const decoded = JSON.parse(
      Buffer.from(issuedCursor ?? '', 'base64url').toString('utf8'),
    ) as { offset: number };
    const editedCursor = Buffer.from(
      JSON.stringify({ ...decoded, offset: 2400 }),
      'utf8',
    ).toString('base64url');

    await expect(
      executeSearchMemory(
        {
          mode: 'fetch',
          refs: ['project:project/long.md'],
          cursor: editedCursor,
        },
        options(docs),
      ),
    ).rejects.toThrow('Invalid cursor.');
  });

  it('reports missing refs without guessing replacements', async () => {
    const result = await executeSearchMemory(
      { mode: 'fetch', refs: ['project:missing.md'] },
      options([]),
    );

    const fetchResult = expectContentResult(result, 'fetch');
    expect(fetchResult.results).toEqual([]);
    expect(fetchResult.missingRefs).toEqual(['project:missing.md']);
    expect(fetchResult.warnings).toEqual([
      'Unknown ref "project:missing.md". Copy the complete ref exactly from the memory tree or a search result.',
    ]);
  });

  it('reports a ref that disappears after the snapshot', async () => {
    vi.mocked(rereadAutoMemoryDocument).mockResolvedValueOnce(null);

    const result = expectContentResult(
      await executeSearchMemory(
        { mode: 'fetch', refs: ['project:project/gone.md'] },
        options([doc('project/gone.md')]),
      ),
      'fetch',
    );

    expect(result.missingRefs).toEqual(['project:project/gone.md']);
    expect(result.warnings?.[0]).toContain('disappeared');
  });

  it('accepts Unicode letter keywords used by recall metadata', async () => {
    for (const keyword of [
      'かな',
      'カナ',
      '한글',
      'память',
      'μνήμη',
      'ذاكرة',
    ]) {
      const result = expectContentResult(
        await executeSearchMemory(
          { mode: 'search', keywords: [keyword] },
          options([
            doc(`project/${keyword.length}.md`, {
              keywords: [keyword],
              body: keyword,
            }),
          ]),
        ),
        'search',
      );
      expect(result.results).toHaveLength(1);
    }
  });

  it('deduplicates requested scopes before filtering a snapshot', async () => {
    const result = expectContentResult(
      await executeSearchMemory(
        {
          mode: 'search',
          keywords: ['project marker'],
          scopes: ['project', 'project'],
        },
        options([
          doc('project/scope.md', {
            keywords: ['project marker'],
            body: 'project marker',
          }),
        ]),
      ),
      'search',
    );

    expect(result.sourceStatus.requestedScopes).toEqual(['project']);
    expect(result.sourceStatus.searchedScopes).toEqual(['project']);
    expect(result.results).toHaveLength(1);
  });

  it('suggests a unique full ref without silently reading it', async () => {
    const result = await executeSearchMemory(
      { mode: 'fetch', refs: ['project/tree.md'] },
      options([doc('project/tree.md', { body: 'tree body' })]),
    );

    const fetchResult = expectContentResult(result, 'fetch');
    expect(fetchResult.results).toEqual([]);
    expect(fetchResult.missingRefs).toEqual(['project/tree.md']);
    expect(fetchResult.warnings).toEqual([
      'Unknown ref "project/tree.md". Did you mean "project:project/tree.md"? Copy refs exactly from the memory tree or a search result.',
    ]);
  });

  it('does not mix body-only matches into qualified metadata results', async () => {
    const docs = [
      doc('project/body.md', {
        body: 'database integration testing needs real dependencies',
      }),
      doc('project/meta.md', {
        title: 'Database testing policy',
        keywords: ['integration testing'],
        body: 'Short rule.',
      }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['integration testing', 'database'],
      },
      options(docs),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:project/meta.md',
    ]);
  });

  it('ranks by weighted match quality across multiple keywords', async () => {
    const docs = [
      doc('project/title.md', {
        title: 'selector',
        body: 'Title match.',
      }),
      doc('project/metadata.md', {
        description: 'provider fallback after selector failures',
        usageScenarios: ['diagnosing status code errors'],
        body: 'Metadata match.',
      }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['selector', 'provider fallback', 'status code'],
      },
      options(docs),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:project/metadata.md',
      'project:project/title.md',
    ]);
    expect(searchResult.results[0]?.matches).toEqual([
      {
        keyword: 'selector',
        source: 'description',
        kind: 'contains',
      },
      {
        keyword: 'provider fallback',
        source: 'description',
        kind: 'contains',
      },
      {
        keyword: 'status code',
        source: 'usage_scenario',
        kind: 'contains',
      },
    ]);
    expect(searchResult.results[1]?.matches).toEqual([
      { keyword: 'selector', source: 'title', kind: 'exact' },
    ]);
    expect(searchResult.results[0]).not.toHaveProperty('description');
    expect(searchResult.results[0]).not.toHaveProperty('keywords');
    expect(searchResult.results[0]).not.toHaveProperty('usageScenarios');
    expect(searchResult.results[0]).not.toHaveProperty('category');
  });

  it('keeps context before the first body match', async () => {
    const body = `${'A'.repeat(500)}target phrase${'B'.repeat(1000)}`;
    const result = await executeSearchMemory(
      { mode: 'search', keywords: ['target phrase'] },
      options([doc('project/context.md', { body })]),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results[0]?.range).toEqual({
      start: 200,
      end: 1400,
      total: body.length,
    });
    expect(searchResult.results[0]?.content).toContain('target phrase');
    expect(searchResult.results[0]?.matches).toEqual([
      { keyword: 'target phrase', source: 'body', kind: 'contains' },
    ]);
  });

  it('maps normalized match offsets back to the original body', async () => {
    const body = `${'\n'.repeat(3000)}${'A'.repeat(3000)}target phrase${'B'.repeat(2000)}`;
    const result = await executeSearchMemory(
      { mode: 'search', keywords: ['target phrase'] },
      options([doc('project/normalized-offset.md', { body })]),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results[0]?.content).toContain('target phrase');
    expect(searchResult.results[0]?.range?.start).toBeGreaterThan(5000);
  });

  it('uses a bounded diversity bonus to cover an otherwise uncovered keyword', async () => {
    const docs = [
      doc('project/a-selector.md', {
        keywords: ['memory selector'],
        body: 'First selector detail.',
      }),
      doc('project/b-selector.md', {
        keywords: ['memory selector'],
        body: 'Second selector detail.',
      }),
      doc('project/z-provider.md', {
        keywords: ['provider fallback'],
        body: 'Provider details.',
      }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['memory selector', 'provider fallback'],
        limit: 2,
      },
      options(docs),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:project/a-selector.md',
      'project:project/z-provider.md',
    ]);
  });

  it('anchors the body window at the region covering the most keywords', async () => {
    const body = `first marker${'A'.repeat(1800)}first marker and second marker`;
    const result = await executeSearchMemory(
      { mode: 'search', keywords: ['first marker', 'second marker'] },
      options([doc('project/dense.md', { body })]),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results[0]?.range?.start).toBeGreaterThan(1000);
    expect(searchResult.results[0]?.content).toContain('first marker');
    expect(searchResult.results[0]?.content).toContain('second marker');
  });

  it('ignores invalid or excess search keywords when at least one keyword remains valid', async () => {
    const docs = [
      doc('reference/pr-review.md', {
        title: 'GitHub review reply limits',
        keywords: ['github review', 'submitted comments'],
        body: 'Submitted GitHub review comments may need a follow-up comment.',
      }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: [
          'PR',
          'GitHub review',
          'submitted comments',
          'follow-up comment',
          'extra ignored term',
          'another ignored term',
          'third ignored term',
        ],
      },
      options(docs),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:reference/pr-review.md',
    ]);
    expect(searchResult.warnings).toEqual([
      'Ignored invalid or excess search keywords: PR, third ignored term',
    ]);
  });

  it('still rejects search when all keywords are invalid', async () => {
    await expect(
      executeSearchMemory(
        {
          mode: 'search',
          keywords: ['PR'],
        },
        options([]),
      ),
    ).rejects.toThrow('search requires at least one valid keyword.');
  });

  it('does not distribute a multi-keyword body fallback across weak memories', async () => {
    const docs = [
      doc('project/database.md', {
        title: 'First detail',
        body: 'database details live here',
      }),
      doc('project/integration.md', {
        title: 'Second detail',
        body: 'integration testing details live here',
      }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['database', 'integration testing'],
      },
      options(docs),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results).toEqual([]);
  });

  it('keeps a strong body fallback despite one incidental metadata hit', async () => {
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['database', 'integration testing'],
      },
      options([
        doc('project/body.md', {
          description: 'Database notes',
          body: 'Integration testing against a database needs real dependencies.',
        }),
      ]),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:project/body.md',
    ]);
  });

  it('drops single generic metadata hits when a strong phrase target exists', async () => {
    const docs = [
      doc('project/send-message-stream.md', {
        title: 'sendMessageStream investigation',
        keywords: ['sendMessageStream lifecycle'],
        description: 'The eight-stage streaming request lifecycle',
        body: 'Complete lifecycle details.',
      }),
      ...Array.from({ length: 4 }, (_, index) =>
        doc(`project/noise-${index}.md`, {
          title: `Unrelated investigation ${index}`,
          keywords: ['component lifecycle'],
          body: 'Unrelated lifecycle details.',
        }),
      ),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['sendMessageStream', 'lifecycle', 'streaming'],
        limit: 5,
      },
      options(docs),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:project/send-message-stream.md',
    ]);
  });

  it('matches a domain-qualified keyword phrase as one exact anchor', async () => {
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['Agent View IPC channel'],
      },
      options([
        doc('project/ipc.md', {
          title: 'Supervisor communication',
          keywords: ['Agent View IPC channel'],
          body: 'Six channel directions.',
        }),
      ]),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:project/ipc.md',
    ]);
  });

  it('rejects out-of-range search limits', async () => {
    await expect(
      executeSearchMemory(
        {
          mode: 'search',
          keywords: ['memory'],
          limit: 20,
        },
        options([]),
      ),
    ).rejects.toThrow('limit must be between 1 and 5');
  });

  it('explores category branches without returning body content', async () => {
    const docs = [
      doc('project/a.md', { body: 'SECRET A' }),
      doc('project/b.md', { body: 'SECRET B' }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'explore',
        branches: [{ category: 'project_introduction' }],
        limitPerBranch: 1,
      },
      options(docs),
    );

    const exploreResult = expectExploreResult(result);
    expect(exploreResult.branches[0]?.total).toBe(2);
    expect(exploreResult.branches[0]?.leaves).toHaveLength(1);
    expect(exploreResult.branches[0]?.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain('SECRET');

    const nextResult = await executeSearchMemory(
      {
        mode: 'explore',
        branches: [
          {
            category: 'project_introduction',
            cursor: exploreResult.branches[0]?.nextCursor,
          },
        ],
        limitPerBranch: 1,
      },
      options(docs),
    );
    const nextExploreResult = expectExploreResult(nextResult);
    expect(
      nextExploreResult.branches[0]?.leaves.map((leaf) => leaf.memoryRef),
    ).toEqual(['project:project/b.md']);
  });

  it('rejects cursors used for a different ref or branch', async () => {
    const docs = [
      doc('project/a.md', {
        keywords: ['cursor source'],
        body: 'cursor source '.repeat(200),
      }),
      doc('project/b.md', { body: 'B'.repeat(1300) }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['cursor source'],
      },
      options(docs),
    );
    const searchResult = expectContentResult(result, 'search');

    await expect(
      executeSearchMemory(
        {
          mode: 'fetch',
          refs: ['project:project/b.md'],
          cursor: searchResult.results[0]?.nextCursor,
        },
        options(docs),
      ),
    ).rejects.toThrow('Invalid cursor.');

    const exploreResult = expectExploreResult(
      await executeSearchMemory(
        {
          mode: 'explore',
          branches: [{ category: 'project_introduction' }],
          limitPerBranch: 1,
        },
        options(docs),
      ),
    );
    await expect(
      executeSearchMemory(
        {
          mode: 'explore',
          branches: [
            {
              category: 'testing_standard',
              cursor: exploreResult.branches[0]?.nextCursor,
            },
          ],
          limitPerBranch: 1,
        },
        options(docs),
      ),
    ).rejects.toThrow('Invalid cursor.');
  });

  it('orders search ties by project, user, team, then relative path', async () => {
    const docs = [
      doc('z.md', {
        scope: 'team',
        keywords: ['integration testing'],
        body: 'Team rule.',
      }),
      doc('b.md', {
        scope: 'user',
        keywords: ['integration testing'],
        body: 'User rule.',
      }),
      doc('a.md', {
        scope: 'project',
        keywords: ['integration testing'],
        body: 'Project rule.',
      }),
    ];
    const result = await executeSearchMemory(
      {
        mode: 'search',
        keywords: ['integration testing'],
      },
      options(docs),
    );

    const searchResult = expectContentResult(result, 'search');
    expect(searchResult.results.map((item) => item.ref)).toEqual([
      'project:a.md',
      'user:b.md',
      'team:z.md',
    ]);
  });

  it('returns router data for root explore', async () => {
    const result = await executeSearchMemory(
      { mode: 'explore' },
      options([
        doc('project/a.md', {
          category: 'testing_standard',
          keywords: ['recall evaluation'],
        }),
      ]),
    );

    const exploreResult = expectExploreResult(result);
    expect(exploreResult.router).toEqual([
      {
        category: 'testing_standard',
        total: 1,
        keywords: ['recall evaluation'],
        hiddenKeywordCount: 0,
      },
    ]);
    expect(exploreResult.branches).toEqual([]);
  });
});
