/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { executeSearchMemory } from '../memory/search-memory.js';
import { SearchMemoryTool } from './search-memory.js';

vi.mock('../memory/search-memory.js', () => ({
  executeSearchMemory: vi.fn(),
}));

function config(): Config {
  const exhaustedBodyRefs = new Set<string>();
  const bodyPresentVersions = new Map<string, number>();
  const bodyCoverage = new Map();
  const requestSignatures = new Set<string>();
  return {
    getProjectRoot: vi.fn().mockReturnValue('/tmp/project'),
    getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
    getTeamMemoryEnabled: vi.fn().mockReturnValue(false),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getMemoryManager: vi.fn().mockReturnValue({
      getBodyPresentVersionsInHistory: vi
        .fn()
        .mockReturnValue(bodyPresentVersions),
      getBodyCoverageInHistory: vi.fn().mockReturnValue(bodyCoverage),
      getExhaustedBodyRefsForCurrentTurn: vi
        .fn()
        .mockReturnValue(exhaustedBodyRefs),
      claimSearchMemoryRequestForCurrentTurn: vi.fn((signature: string) => {
        if (requestSignatures.has(signature)) return false;
        requestSignatures.add(signature);
        return true;
      }),
      releaseSearchMemoryRequestForCurrentTurn: vi.fn((signature: string) => {
        requestSignatures.delete(signature);
      }),
    }),
  } as unknown as Config;
}

describe('SearchMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is directly visible so the model can pull memory without ToolSearch', () => {
    const tool = new SearchMemoryTool(config());

    expect(tool.shouldDefer).toBe(false);
  });

  it('rejects stale historical calls while the legacy protocol is active', async () => {
    const mockConfig = config();
    vi.mocked(mockConfig.getMemoryRecallMode).mockReturnValue('legacy');
    const result = await new SearchMemoryTool(mockConfig)
      .build({ mode: 'fetch', refs: ['project:reference/legacy.md'] })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe('execution_denied');
    expect(result.llmContent).toContain('legacy memory protocol');
    expect(executeSearchMemory).not.toHaveBeenCalled();
  });

  it('keeps the compact mode-selection and body-window contract', () => {
    const schema = new SearchMemoryTool(config()).schema;
    const parameters = schema.parametersJsonSchema as {
      properties: Record<string, { description?: string }>;
    };

    expect(schema.description).toContain('visible memory metadata');
    expect(schema.description).toContain('Fetch exact refs');
    expect(schema.description).toContain('search terms or phrases');
    expect(schema.description).toContain('explore categories');
    expect(schema.description).toContain('returned ref and cursor');
    expect(parameters.properties['refs']?.description).toContain(
      'project:project/compaction-pipeline.md',
    );
    expect(parameters.properties['branches']?.description).toContain('explore');
    expect(parameters.properties['cursor']?.description).toContain(
      'fetch only',
    );
    expect(parameters.properties['categories']?.description).toContain(
      'search',
    );
    expect(JSON.stringify(schema).length).toBeLessThanOrEqual(2_600);
  });

  it('exposes fixed category enums for search filters and explore branches', () => {
    const schema = new SearchMemoryTool(config()).schema;
    const parameters = schema.parametersJsonSchema as {
      properties: {
        keywords: { maxItems: number };
        categories: { items: { enum: string[] } };
        branches: { items: { properties: { category: { enum: string[] } } } };
      };
    };

    expect(parameters.properties.keywords.maxItems).toBe(5);
    expect(parameters.properties.categories.items.enum).toContain(
      'testing_standard',
    );
    expect(parameters.properties.categories.items.enum).toContain(
      'uncategorized',
    );
    expect(parameters.properties.categories.items.enum).not.toContain('user');
    expect(
      parameters.properties.branches.items.properties.category.enum,
    ).toEqual(parameters.properties.categories.items.enum);
  });

  it('validates mode-specific required fields', () => {
    const tool = new SearchMemoryTool(config());

    expect(tool.validateToolParams({ mode: 'fetch', refs: [] })).toContain(
      'must NOT have fewer than 1 items',
    );
    expect(tool.validateToolParams({ mode: 'search', keywords: [] })).toContain(
      'must NOT have fewer than 1 items',
    );
    expect(
      tool.validateToolParams({
        mode: 'search',
        keywords: ['memory'],
        limit: 20,
      }),
    ).toContain('must be <= 5');
    expect(
      tool.validateToolParams({
        mode: 'explore',
        categories: ['task_summary'],
      } as unknown as Parameters<SearchMemoryTool['validateToolParams']>[0]),
    ).toBe('explore accepts scopes, branches, and limitPerBranch.');
    expect(
      tool.validateToolParams({
        mode: 'search',
        keywords: ['memory'],
        branches: [{ category: 'task_summary' }],
      } as unknown as Parameters<SearchMemoryTool['validateToolParams']>[0]),
    ).toBe('search accepts keywords, scopes, categories, and limit.');
    expect(
      tool.validateToolParams({
        mode: 'search',
        query: 'memory',
        keywords: ['memory'],
      } as unknown as Parameters<SearchMemoryTool['validateToolParams']>[0]),
    ).toContain('must NOT have additional properties');
    expect(
      tool.validateToolParams({
        mode: 'fetch',
        refs: ['project:project/memory.md'],
        scopes: ['project'],
      } as unknown as Parameters<SearchMemoryTool['validateToolParams']>[0]),
    ).toBeNull();
    expect(
      tool.validateToolParams({
        mode: 'search',
        keywords: ['memory'],
        limitPerBranch: 3,
      } as unknown as Parameters<SearchMemoryTool['validateToolParams']>[0]),
    ).toBe('search accepts keywords, scopes, categories, and limit.');
    expect(tool.validateToolParams({ mode: 'explore' })).toBeNull();
  });

  it('executes with project trust and team-memory visibility from config', async () => {
    const mockConfig = config();
    vi.mocked(executeSearchMemory).mockResolvedValue({
      mode: 'explore',
      sourceStatus: {
        requestedScopes: ['project'],
        searchedScopes: ['project'],
        unavailableScopes: [],
        complete: true,
        incompleteScopes: [],
      },
      branches: [],
      router: [],
    });

    const result = await new SearchMemoryTool(mockConfig)
      .build({ mode: 'explore' })
      .execute(new AbortController().signal);

    expect(executeSearchMemory).toHaveBeenCalledWith(
      { mode: 'explore' },
      {
        projectRoot: '/tmp/project',
        teamMemoryEnabled: false,
        trustedProject: true,
        bodyPresentVersions: expect.any(Map),
        bodyCoverage: expect.any(Map),
        exhaustedBodyRefs: expect.any(Set),
        onComplete: expect.any(Function),
      },
    );
    expect(result.llmContent).toContain('"mode": "explore"');
  });

  it('rejects an identical request repeated in the same turn', async () => {
    const mockConfig = config();
    vi.mocked(executeSearchMemory).mockResolvedValue({
      mode: 'search',
      sourceStatus: {
        requestedScopes: ['project'],
        searchedScopes: ['project'],
        unavailableScopes: [],
        complete: true,
        incompleteScopes: [],
      },
      results: [],
    });
    const tool = new SearchMemoryTool(mockConfig);
    const params = { mode: 'search' as const, keywords: ['memory selector'] };

    await tool.build(params).execute(new AbortController().signal);
    const duplicate = await tool
      .build(params)
      .execute(new AbortController().signal);

    expect(executeSearchMemory).toHaveBeenCalledTimes(1);
    expect(duplicate.llmContent).toContain('"duplicateRequest": true');
    expect(duplicate.llmContent).toContain('previous result');
  });

  it('lets repeated fetches reach version-aware body handling', async () => {
    const mockConfig = config();
    vi.mocked(executeSearchMemory).mockResolvedValue({
      mode: 'fetch',
      sourceStatus: {
        requestedScopes: ['project'],
        searchedScopes: ['project'],
        unavailableScopes: [],
        complete: true,
        incompleteScopes: [],
      },
      results: [],
    });
    const tool = new SearchMemoryTool(mockConfig);
    const params = {
      mode: 'fetch' as const,
      refs: ['project:project/tree.md'],
    };

    await tool.build(params).execute(new AbortController().signal);
    await tool.build(params).execute(new AbortController().signal);

    expect(executeSearchMemory).toHaveBeenCalledTimes(2);
  });

  it('allows retrying an identical request after execution fails', async () => {
    const mockConfig = config();
    vi.mocked(executeSearchMemory)
      .mockRejectedValueOnce(new Error('transient root failure'))
      .mockResolvedValueOnce({
        mode: 'explore',
        sourceStatus: {
          requestedScopes: ['project'],
          searchedScopes: ['project'],
          unavailableScopes: [],
          complete: true,
          incompleteScopes: [],
        },
        branches: [],
        router: [],
      });
    const tool = new SearchMemoryTool(mockConfig);
    const params = { mode: 'explore' as const };

    await expect(
      tool.build(params).execute(new AbortController().signal),
    ).rejects.toThrow('transient root failure');
    const retry = await tool
      .build(params)
      .execute(new AbortController().signal);

    expect(executeSearchMemory).toHaveBeenCalledTimes(2);
    expect(retry.llmContent).toContain('"mode": "explore"');
  });
});
