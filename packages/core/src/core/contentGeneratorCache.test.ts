/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  AuthType,
  type ContentGenerator,
  type ContentGeneratorConfig,
} from './contentGenerator.js';
import { createContentGenerator } from './contentGenerator.js';
import { createContentGeneratorForModelResolver } from './contentGeneratorCache.js';

vi.mock('./contentGenerator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contentGenerator.js')>();
  return {
    ...actual,
    createContentGenerator: vi.fn(),
  };
});

const mainGenerator = {
  generateContent: vi.fn(),
} as unknown as ContentGenerator;
const fastGenerator = {
  generateContent: vi.fn(),
} as unknown as ContentGenerator;

function makeConfig(
  contentGeneratorConfig: Partial<ContentGeneratorConfig> = {},
): Config {
  return {
    getModel: vi.fn().mockReturnValue('qwen-main'),
    getContentGeneratorConfig: vi.fn().mockReturnValue({
      model: 'qwen-main',
      authType: AuthType.USE_OPENAI,
      apiKey: 'main-key',
      baseUrl: 'https://main.example.com',
      ...contentGeneratorConfig,
    }),
    getModelsConfig: vi.fn().mockReturnValue({
      getResolvedModel: vi.fn().mockReturnValue(undefined),
    }),
  } as unknown as Config;
}

describe('createContentGeneratorForModelResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the main generator for the configured main model', async () => {
    const config = makeConfig();
    const resolveGenerator = createContentGeneratorForModelResolver(
      config,
      () => mainGenerator,
    );

    await expect(resolveGenerator('qwen-main')).resolves.toBe(mainGenerator);
    expect(createContentGenerator).not.toHaveBeenCalled();
  });

  it('creates and reuses one pending generator promise for the same side model', async () => {
    const config = makeConfig();
    let resolveCreate: (generator: ContentGenerator) => void = () => {};
    vi.mocked(createContentGenerator).mockReturnValue(
      new Promise<ContentGenerator>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const resolveGenerator = createContentGeneratorForModelResolver(
      config,
      () => mainGenerator,
    );

    const first = resolveGenerator('qwen-fast');
    const second = resolveGenerator('qwen-fast');
    resolveCreate(fastGenerator);

    await expect(first).resolves.toBe(fastGenerator);
    await expect(second).resolves.toBe(fastGenerator);
    expect(createContentGenerator).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the main generator when side generator creation fails', async () => {
    const config = makeConfig();
    vi.mocked(createContentGenerator).mockRejectedValue(new Error('bad fast'));
    const resolveGenerator = createContentGeneratorForModelResolver(
      config,
      () => mainGenerator,
    );

    await expect(resolveGenerator('qwen-fast')).rejects.toThrow('bad fast');
  });

  it('fails explicitly when authType is missing for a side model', async () => {
    const config = makeConfig({ authType: undefined });
    const resolveGenerator = createContentGeneratorForModelResolver(
      config,
      () => mainGenerator,
    );

    await expect(resolveGenerator('qwen-fast')).rejects.toThrow(
      'authType is not configured',
    );
    expect(createContentGenerator).not.toHaveBeenCalled();
  });

  it('removes failed generator promises so later calls can retry', async () => {
    const config = makeConfig();
    vi.mocked(createContentGenerator)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(fastGenerator);
    const resolveGenerator = createContentGeneratorForModelResolver(
      config,
      () => mainGenerator,
    );

    await expect(resolveGenerator('qwen-fast')).rejects.toThrow('temporary');
    await expect(resolveGenerator('qwen-fast')).resolves.toBe(fastGenerator);
    expect(createContentGenerator).toHaveBeenCalledTimes(2);
  });
});
