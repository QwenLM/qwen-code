/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  collectContextData,
  formatContextUsageText,
} from './contextCommand.js';

// uiTelemetryService is consumed inside collectContextData via the
// re-export from core; mock it here so the function returns deterministic
// numbers without needing a real session. The mock fns live inside
// vi.hoisted so they are available when vi.mock's factory runs (vi.mock
// is hoisted above module-level const declarations).
const { mockGetLastPromptTokenCount, mockGetLastCachedContentTokenCount } =
  vi.hoisted(() => ({
    mockGetLastPromptTokenCount: vi.fn().mockReturnValue(0),
    mockGetLastCachedContentTokenCount: vi.fn().mockReturnValue(0),
  }));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    uiTelemetryService: {
      getLastPromptTokenCount: mockGetLastPromptTokenCount,
      getLastCachedContentTokenCount: mockGetLastCachedContentTokenCount,
    },
  };
});

function makeMockConfig(contextWindowSize = 32_000): Config {
  return {
    getModel: vi.fn().mockReturnValue('test-model'),
    getContentGeneratorConfig: vi.fn().mockReturnValue({
      contextWindowSize,
    }),
    getToolRegistry: vi.fn().mockReturnValue({
      getAllTools: vi.fn().mockReturnValue([]),
      getFunctionDeclarations: vi.fn().mockReturnValue([]),
    }),
    getUserMemory: vi.fn().mockReturnValue(''),
    getSkillManager: vi.fn().mockReturnValue({
      listSkills: vi.fn().mockResolvedValue([]),
    }),
    getChatCompression: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

describe('collectContextData (contextCommand)', () => {
  let getFunctionDeclarationsSpy: ReturnType<typeof vi.fn>;
  let mockConfig: Config;

  beforeEach(() => {
    mockGetLastPromptTokenCount.mockReturnValue(0);
    mockGetLastCachedContentTokenCount.mockReturnValue(0);
    getFunctionDeclarationsSpy = vi.fn().mockReturnValue([]);
    mockConfig = {
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        contextWindowSize: 32_000,
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([]),
        getFunctionDeclarations: getFunctionDeclarationsSpy,
      }),
      getUserMemory: vi.fn().mockReturnValue(''),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
      }),
      getChatCompression: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
  });

  it('queries getFunctionDeclarations with no args, matching the actual API request', async () => {
    // /context should reflect what's actually sent to the model. Deferred
    // tools (MCP tools default to shouldDefer=true) are excluded from the
    // prompt unless ToolSearch has revealed them this session — see
    // client.ts which calls getFunctionDeclarations() with no options.
    // Pinning the call here keeps the /context token estimate aligned with
    // the real request, instead of overcounting by the full MCP tool pool.
    await collectContextData(mockConfig, false);

    expect(getFunctionDeclarationsSpy).toHaveBeenCalledTimes(1);
    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith();
  });

  it('excludes deferred-but-not-revealed tools from the per-tool breakdown (#4508)', async () => {
    // Regression: /context used to surface every deferred tool (MCP tools,
    // plus low-frequency built-ins like web_fetch / monitor / cron_*) even
    // when ToolSearch had not loaded any of them, inflating the displayed
    // token count for the common default-on case.
    const isDeferredToolRevealed = vi.fn().mockReturnValue(false);
    const hiddenBuiltin = {
      name: 'web_fetch',
      schema: { name: 'web_fetch', description: 'large schema' },
      shouldDefer: true,
      alwaysLoad: false,
    };
    const hiddenMcp = {
      name: 'mcp__server__tool',
      schema: { name: 'mcp__server__tool', description: 'large schema' },
      shouldDefer: true,
      alwaysLoad: false,
    };
    const config = {
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        contextWindowSize: 32_000,
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([hiddenBuiltin, hiddenMcp]),
        getFunctionDeclarations: vi.fn().mockReturnValue([]),
        isDeferredToolRevealed,
      }),
      getUserMemory: vi.fn().mockReturnValue(''),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
      }),
      getChatCompression: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.builtinTools).toHaveLength(0);
    expect(data.mcpTools).toHaveLength(0);
    expect(isDeferredToolRevealed).toHaveBeenCalledWith('web_fetch');
    expect(isDeferredToolRevealed).toHaveBeenCalledWith('mcp__server__tool');
  });
});

describe('/context shows three-tier thresholds', () => {
  beforeEach(() => {
    mockGetLastPromptTokenCount.mockReturnValue(0);
    mockGetLastCachedContentTokenCount.mockReturnValue(0);
  });

  it('renders warn/auto/hard with the warn-tier marker when usage sits between warn and auto', async () => {
    // 200K window. computeThresholds(200K) = {
    //   warn: 147,000, auto: 167,000, hard: 177,000, effectiveWindow: 180,000
    // }
    // lastPromptTokenCount = 150K → between warn and auto → tier = warn.
    mockGetLastPromptTokenCount.mockReturnValue(150_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    const text = formatContextUsageText(data);

    expect(text).toMatch(/Effective window:\s+180,000/);
    expect(text).toMatch(/Warn threshold:\s+147,000/);
    expect(text).toMatch(/Auto threshold:\s+167,000/);
    expect(text).toMatch(/Hard threshold:\s+177,000/);
    expect(text).toMatch(/Current tier:\s+warn/);
    expect(data.breakdown.currentTier).toBe('warn');
    expect(data.breakdown.thresholds).toEqual({
      effectiveWindow: 180_000,
      warn: 147_000,
      auto: 167_000,
      hard: 177_000,
    });
  });

  it('classifies usage below the warn threshold as the safe tier', async () => {
    mockGetLastPromptTokenCount.mockReturnValue(50_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    const text = formatContextUsageText(data);

    expect(text).toMatch(/Current tier:\s+safe/);
    expect(data.breakdown.currentTier).toBe('safe');
  });

  it('classifies usage at or above the hard threshold as the hard tier', async () => {
    mockGetLastPromptTokenCount.mockReturnValue(180_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    expect(data.breakdown.currentTier).toBe('hard');
  });

  it('classifies usage between auto and hard as the auto tier', async () => {
    // 200K window — between 167K (auto) and 177K (hard) → tier = auto.
    mockGetLastPromptTokenCount.mockReturnValue(170_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    expect(data.breakdown.currentTier).toBe('auto');
    const text = formatContextUsageText(data);
    expect(text).toMatch(/Current tier:\s+auto/);
  });

  it('treats no-API-data sessions as safe and omits the threshold section from text', async () => {
    // lastPromptTokenCount = 0 → collectContextData uses the estimated branch
    // (classifies against `rawOverhead`, not apiTotalTokens). With these
    // default fixtures rawOverhead lands well below `warn`, so currentTier
    // resolves to `safe`. On heavy system-prompt / skill / MCP loads the
    // estimated branch can return warn/auto/hard — this test only covers
    // the default-fixture safe case. formatContextUsageText must NOT emit
    // the "Compaction thresholds" section because the estimated path
    // renders a different layout.
    mockGetLastPromptTokenCount.mockReturnValue(0);
    const data = await collectContextData(makeMockConfig(200_000), false);
    expect(data.breakdown.currentTier).toBe('safe');
    // Thresholds are still computed and exposed on the breakdown for downstream
    // consumers, even though the text layout suppresses them.
    expect(data.breakdown.thresholds.auto).toBe(167_000);
    const text = formatContextUsageText(data);
    expect(text).not.toMatch(/Compaction thresholds/);
  });
});
