/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { collectContextData } from './contextCommand.js';

// uiTelemetryService is consumed inside collectContextData via the
// re-export from core; mock it here so the function returns deterministic
// numbers without needing a real session.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    uiTelemetryService: {
      getLastPromptTokenCount: vi.fn().mockReturnValue(0),
      getLastCachedContentTokenCount: vi.fn().mockReturnValue(0),
    },
  };
});

describe('collectContextData (contextCommand)', () => {
  let getFunctionDeclarationsSpy: ReturnType<typeof vi.fn>;
  let mockConfig: Config;

  beforeEach(() => {
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

  it('passes includeDeferred: true to getFunctionDeclarations', async () => {
    // Pin the token-accounting invariant: the "all tools" total must
    // line up with the per-tool breakdown (which iterates getAllTools
    // unfiltered). Without `includeDeferred: true`, the total would
    // exclude deferred tools while the per-tool sum still includes
    // them — `displayBuiltinTools` (clamped Math.max(0, …)) would then
    // collapse to 0 instead of reporting the real cost. A user-visible
    // regression caught only by visual inspection of `/context detail`.
    await collectContextData(mockConfig, false);

    expect(getFunctionDeclarationsSpy).toHaveBeenCalledTimes(1);
    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith({
      includeDeferred: true,
    });
  });
});
