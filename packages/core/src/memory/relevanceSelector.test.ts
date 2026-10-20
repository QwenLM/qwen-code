/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSideQuery } from '../utils/sideQuery.js';
import type { Config } from '../config/config.js';
import type { ScannedAutoMemoryDocument } from './scan.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';

vi.mock('../utils/sideQuery.js', () => ({
  runSideQuery: vi.fn(),
}));

const docs: ScannedAutoMemoryDocument[] = [
  {
    scope: 'user',
    type: 'user',
    filePath: '/tmp/user.md',
    relativePath: 'user.md',
    filename: 'user.md',
    title: 'User Memory',
    description: 'User preferences',
    category: 'uncategorized',
    keywords: [],
    usageScenarios: [],
    body: '- User prefers terse responses.',
    mtimeMs: 1,
  },
  {
    scope: 'project',
    type: 'reference',
    filePath: '/tmp/reference.md',
    relativePath: 'reference.md',
    filename: 'reference.md',
    title: 'Reference Memory',
    description: 'Operational references',
    category: 'uncategorized',
    keywords: [],
    usageScenarios: [],
    body: '- Grafana dashboard: https://grafana.internal/d/api-latency',
    mtimeMs: 2,
  },
];

describe('selectRelevantAutoMemoryDocumentsByModel', () => {
  const mockConfig = {
    getFastModel: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  type SelectArgs = Parameters<typeof selectRelevantAutoMemoryDocumentsByModel>;
  const select = (
    ...args: SelectArgs extends [Config, ...infer R] ? R : never
  ) => selectRelevantAutoMemoryDocumentsByModel(mockConfig, ...args);
  const sideQueryOptions = () => vi.mocked(runSideQuery).mock.calls[0]![1];
  const promptText = () => sideQueryOptions().contents[0]?.parts?.[0]?.text;
  const expectRecallQuery = () =>
    expect(runSideQuery).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        purpose: 'auto-memory-recall',
        config: { temperature: 0 },
      }),
    );
  // The selector's validate() runs on the chosen paths, as runSideQuery would.
  const selectorReturnsValidated = (selected: string[]) =>
    vi.mocked(runSideQuery).mockImplementation(async (_config, options) => {
      const result = { selected_memories: selected };
      const error = options.validate?.(result);
      if (error) throw new Error(error);
      return result;
    });

  it('returns documents chosen by the side-query selector', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: ['/tmp/user.md'],
    });

    expect(await select('check preferences', docs, 2, [])).toEqual([docs[0]]);
    expectRecallQuery();
  });

  it('returns an empty list for empty query or no docs', async () => {
    await expect(select('   ', docs, 2)).resolves.toEqual([]);
    await expect(select('hello', [], 2)).resolves.toEqual([]);
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('forwards caller abort signal to runSideQuery combined with timeout', async () => {
    const callerController = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    vi.mocked(runSideQuery).mockImplementation(async (_config, opts) => {
      capturedSignal = opts.abortSignal;
      return { selected_memories: [] };
    });

    await select('check preferences', docs, 2, [], callerController.signal);

    expect(runSideQuery).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    callerController.abort();

    await vi.waitFor(() => {
      expect(capturedSignal!.aborted).toBe(true);
    });
  });

  it('uses timeout-only abort signal when no caller signal provided', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: [],
    });

    await select('check preferences', docs, 2);

    expect(runSideQuery).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('tells the selector not to recall active tool schemas or failed calls', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: [],
    });

    await select('read the ATA article', docs, 2, [
      'mcp__ata__article-list-query',
    ]);

    const options = sideQueryOptions();
    expect(options.systemInstruction).toContain(
      'parameter schemas, field mappings, guessed call formats, or failed-call transcripts',
    );
    expect(options.systemInstruction).toContain(
      'known gotchas, warnings, or confirmed workarounds',
    );
    expect(JSON.stringify(options.contents)).toContain(
      'Recently used tools: mcp__ata__article-list-query',
    );
  });

  it('adds compact keywords while keeping scenarios and bodies out of the selector manifest', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({ selected_memories: [] });
    const metadataDoc = {
      ...docs[1]!,
      keywords: ['latency dashboard'],
      usageScenarios: ['Debugging latency'],
      body: 'SECRET MEMORY BODY',
    };

    await selectRelevantAutoMemoryDocumentsByModel(
      mockConfig,
      'latency',
      [metadataDoc],
      2,
    );

    const text =
      vi.mocked(runSideQuery).mock.calls[0]![1].contents[0]?.parts?.[0]?.text ??
      '';
    expect(text).toContain(metadataDoc.filePath);
    expect(text).toContain(metadataDoc.description);
    expect(text).toContain('keywords: latency dashboard');
    expect(text).not.toContain('Debugging latency');
    expect(text).not.toContain('SECRET MEMORY BODY');
  });

  it('limits selector metadata to three sanitized keywords', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({ selected_memories: [] });
    const metadataDoc = {
      ...docs[1]!,
      keywords: ['one', 'two\nlines', 'three', 'four'],
    };

    await selectRelevantAutoMemoryDocumentsByModel(
      mockConfig,
      'find details',
      [metadataDoc],
      2,
    );

    const text =
      vi.mocked(runSideQuery).mock.calls[0]![1].contents[0]?.parts?.[0]?.text ??
      '';
    expect(text).toContain('keywords: one, two lines, three');
    expect(text).not.toContain('four');
  });

  it.each([
    [
      'lets runSideQuery choose the default side-query model when fast model is configured',
      'fast-flash-model',
    ],
    [
      'lets runSideQuery fall back to its default when no fast model is configured',
      undefined,
    ],
  ])('%s', async (_title, fastModel) => {
    vi.mocked(mockConfig.getFastModel).mockReturnValue(fastModel);
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: ['reference.md'],
    });

    await select('check the latency dashboard', docs, 2);

    expectRecallQuery();
    expect('model' in (sideQueryOptions() as object)).toBe(false);
  });

  it('throws when selector returns unknown file paths', async () => {
    selectorReturnsValidated(['/tmp/unknown.md']);

    await expect(select('check memory', docs, 2)).rejects.toThrow(
      'Recall selector returned unknown file path',
    );
  });

  it('distinguishes docs with identical relativePath across scopes', async () => {
    // Dual-scope dedupe regression: `user/role.md` exists in both project and
    // user memory dirs. Keying by relativePath collapsed them; filePath must not.
    const dualScopeDocs: ScannedAutoMemoryDocument[] = [
      {
        scope: 'project',
        type: 'user',
        filePath: '/qwen/projects/proj/memory/user/role.md',
        relativePath: 'user/role.md',
        filename: 'role.md',
        title: 'Project User',
        description: 'Project-scoped user note',
        category: 'uncategorized',
        keywords: [],
        usageScenarios: [],
        body: '- Project-specific.',
        mtimeMs: 1,
      },
      {
        scope: 'user',
        type: 'user',
        filePath: '/qwen/memories/user/role.md',
        relativePath: 'user/role.md',
        filename: 'role.md',
        title: 'Cross-Project User',
        description: 'User-scoped cross-project note',
        category: 'uncategorized',
        keywords: [],
        usageScenarios: [],
        body: '- Applies everywhere.',
        mtimeMs: 2,
      },
    ];
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: [
        '/qwen/projects/proj/memory/user/role.md',
        '/qwen/memories/user/role.md',
      ],
    });

    const result = await select('who is the user', dualScopeDocs, 5, []);

    expect(result).toHaveLength(2);
    expect(result.map((d) => d.filePath)).toEqual([
      '/qwen/projects/proj/memory/user/role.md',
      '/qwen/memories/user/role.md',
    ]);
  });

  it('bounds the model manifest by UTF-8 bytes', async () => {
    const largeDocs = Array.from({ length: 200 }, (_, index) => ({
      ...docs[0],
      filePath: `/tmp/bounded-${index}.md`,
      relativePath: `bounded-${index}.md`,
      filename: `bounded-${index}.md`,
      description: `${'界'.repeat(511)}😀${'x'.repeat(2_000)}`,
      mtimeMs: index,
    }));
    selectorReturnsValidated(['/tmp/bounded-199.md']);

    await expect(select('semantic-only request', largeDocs, 5)).rejects.toThrow(
      'Recall selector returned unknown file path',
    );

    const manifest =
      (promptText() ?? '').split('Available memories:\n')[1] ?? '';
    expect(manifest).toContain('/tmp/bounded-0.md');
    expect(manifest).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(manifest).not.toContain('x');
    expect(Buffer.byteLength(manifest, 'utf8')).toBeLessThanOrEqual(25_000);
  });

  it('keeps fitting documents after an overflowing manifest entry', async () => {
    const largeDocs = Array.from({ length: 16 }, (_, index) => ({
      ...docs[0],
      filePath: `/tmp/large-${index}.md`,
      description: '界'.repeat(512),
    }));
    const shortDoc = {
      ...docs[1],
      filePath: '/tmp/short-after-overflow.md',
      description: 'short',
    };
    selectorReturnsValidated([shortDoc.filePath]);

    await expect(
      select('check memory', [...largeDocs, shortDoc], 5),
    ).resolves.toEqual([shortDoc]);

    expect(promptText()).toContain(shortDoc.filePath);
    expect(promptText()).not.toContain('/tmp/large-15.md');
  });

  it('keeps interleaved recent candidates inside a full manifest', async () => {
    const lexicalDocs = Array.from({ length: 180 }, (_, index) => ({
      ...docs[0],
      filePath: `/tmp/lexical-${index}.md`,
      description: 'lexical candidate '.repeat(6),
    }));
    const recentDocs = Array.from({ length: 20 }, (_, index) => ({
      ...docs[1],
      filePath: `/tmp/recent-${index}.md`,
      description: 'recent candidate '.repeat(6),
    }));
    const candidates = lexicalDocs
      .slice(0, recentDocs.length)
      .flatMap((doc, index) => [doc, recentDocs[index]!]);
    candidates.push(...lexicalDocs.slice(recentDocs.length));
    const recentTarget = recentDocs.at(-1)!;
    selectorReturnsValidated([recentTarget.filePath]);

    await expect(
      select('common project query', candidates, 5),
    ).resolves.toEqual([recentTarget]);
  });

  it('does not let long descriptions starve lexical-first candidates', async () => {
    const longDocs = Array.from({ length: 20 }, (_, index) => ({
      ...docs[0],
      filePath: `/tmp/recent-${index}.md`,
      description: '界'.repeat(512),
    }));
    const lexicalDoc = {
      ...docs[1],
      filePath: '/tmp/lexical-target.md',
    };
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: [lexicalDoc.filePath],
    });

    await expect(
      select('find the lexical target', [lexicalDoc, ...longDocs], 5),
    ).resolves.toEqual([lexicalDoc]);

    expect(promptText()).toContain(lexicalDoc.filePath);
  });
});
