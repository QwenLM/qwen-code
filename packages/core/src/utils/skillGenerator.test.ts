/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { skillGenerator } from './skillGenerator.js';
import type { Config } from '../config/config.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';

describe('skillGenerator', () => {
  let mockClient: BaseLlmClient;
  let mockConfig: Config;
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    mockClient = {
      generateJson: vi.fn(),
    } as unknown as BaseLlmClient;

    mockConfig = {
      getBaseLlmClient: () => mockClient,
      getModel: () => 'test-model',
    } as unknown as Config;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should generate skill content successfully', async () => {
    const mockResponse = {
      name: 'test-skill',
      description: 'Test description',
      instructions: 'Test instructions',
    };
    (mockClient.generateJson as Mock).mockResolvedValue(mockResponse);

    const result = await skillGenerator(
      'create a test skill',
      mockConfig,
      abortSignal,
    );

    expect(result).toEqual(mockResponse);
    expect(mockClient.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining('elite skill architect'),
        schema: expect.any(Object),
      }),
    );
  });

  it('should throw error for empty description', async () => {
    await expect(skillGenerator('  ', mockConfig, abortSignal)).rejects.toThrow(
      'User description cannot be empty',
    );
    expect(mockClient.generateJson).not.toHaveBeenCalled();
  });

  it('should throw error for invalid response', async () => {
    (mockClient.generateJson as Mock).mockResolvedValue({});

    await expect(
      skillGenerator('create a test skill', mockConfig, abortSignal),
    ).rejects.toThrow('Invalid response from LLM');
  });

  it('should throw error when LLM response is null', async () => {
    (mockClient.generateJson as Mock).mockResolvedValue(null);

    await expect(
      skillGenerator('create another skill', mockConfig, abortSignal),
    ).rejects.toThrow('Invalid response from LLM');
  });
});
