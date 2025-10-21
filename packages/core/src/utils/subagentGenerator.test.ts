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
  type Mock,
  afterEach,
} from 'vitest';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import type { Config } from '../config/config.js';
import {
  subagentGenerator,
  type SubagentGeneratedContent,
} from './subagentGenerator.js';

describe('subagentGenerator', () => {
  let mockClient: BaseLlmClient;
  let mockConfig: Config;
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    // Create a mock client with generateJson method
    mockClient = {
      generateJson: vi.fn(),
    } as unknown as BaseLlmClient;

    // Create a mock config that returns the mock client and model
    mockConfig = {
      getBaseLlmClient: vi.fn().mockReturnValue(mockClient),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    } as unknown as Config;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error for empty user description', async () => {
    await expect(
      subagentGenerator('', mockConfig, abortSignal),
    ).rejects.toThrow('User description cannot be empty');

    await expect(
      subagentGenerator('   ', mockConfig, abortSignal),
    ).rejects.toThrow('User description cannot be empty');

    expect(mockClient.generateJson).not.toHaveBeenCalled();
  });

  it('should successfully generate content with valid LLM response', async () => {
    const userDescription = 'help with code reviews and suggestions';
    const mockApiResponse: SubagentGeneratedContent = {
      name: 'code-review-assistant',
      description:
        'A specialized subagent that helps with code reviews and provides improvement suggestions.',
      systemPrompt:
        'You are a code review expert. Analyze code for best practices, bugs, and improvements.',
    };

    (mockClient.generateJson as Mock).mockResolvedValue(mockApiResponse);

    const result = await subagentGenerator(
      userDescription,
      mockConfig,
      abortSignal,
    );

    expect(result).toEqual(mockApiResponse);
    expect(mockClient.generateJson).toHaveBeenCalledTimes(1);

    // Verify the call parameters - now it's a single object parameter
    const generateJsonCall = (mockClient.generateJson as Mock).mock.calls[0];
    const callParams = generateJsonCall[0];

    // Check the contents
    expect(callParams.contents).toHaveLength(1);
    expect(callParams.contents[0]?.role).toBe('user');
    expect(callParams.contents[0]?.parts?.[0]?.text).toContain(
      `Create an agent configuration based on this request: "${userDescription}"`,
    );

    // Check other parameters
    expect(callParams.abortSignal).toBe(abortSignal);
    expect(callParams.model).toBe('qwen3-coder-plus');
    expect(callParams.systemInstruction).toContain(
      'You are an elite AI agent architect',
    );
  });

  it('should throw error when LLM response is missing required fields', async () => {
    const userDescription = 'help with documentation';
    const incompleteResponse = {
      name: 'doc-helper',
      description: 'Helps with documentation',
      // Missing systemPrompt
    };

    (mockClient.generateJson as Mock).mockResolvedValue(incompleteResponse);

    await expect(
      subagentGenerator(userDescription, mockConfig, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');

    expect(mockClient.generateJson).toHaveBeenCalledTimes(1);
  });

  it('should throw error when LLM response has empty fields', async () => {
    const userDescription = 'database optimization';
    const emptyFieldsResponse = {
      name: '',
      description: 'Helps with database optimization',
      systemPrompt: 'You are a database expert.',
    };

    (mockClient.generateJson as Mock).mockResolvedValue(emptyFieldsResponse);

    await expect(
      subagentGenerator(userDescription, mockConfig, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');
  });

  it('should throw error when generateJson throws an error', async () => {
    const userDescription = 'testing automation';
    (mockClient.generateJson as Mock).mockRejectedValue(new Error('API Error'));

    await expect(
      subagentGenerator(userDescription, mockConfig, abortSignal),
    ).rejects.toThrow('API Error');
  });

  it('should call generateJson with correct schema and model', async () => {
    const userDescription = 'data analysis';
    const mockResponse: SubagentGeneratedContent = {
      name: 'data-analyst',
      description: 'Analyzes data and provides insights.',
      systemPrompt: 'You are a data analysis expert.',
    };

    (mockClient.generateJson as Mock).mockResolvedValue(mockResponse);

    await subagentGenerator(userDescription, mockConfig, abortSignal);

    expect(mockClient.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'qwen3-coder-plus',
        contents: expect.any(Object),
        schema: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            name: expect.objectContaining({ type: 'string' }),
            description: expect.objectContaining({ type: 'string' }),
            systemPrompt: expect.objectContaining({ type: 'string' }),
          }),
          required: ['name', 'description', 'systemPrompt'],
        }),
        abortSignal,
        systemInstruction: expect.stringContaining(
          'You are an elite AI agent architect',
        ),
      }),
    );
  });

  it('should include user description in the prompt', async () => {
    const userDescription = 'machine learning model training';
    const mockResponse: SubagentGeneratedContent = {
      name: 'ml-trainer',
      description: 'Trains machine learning models.',
      systemPrompt: 'You are an ML expert.',
    };

    (mockClient.generateJson as Mock).mockResolvedValue(mockResponse);

    await subagentGenerator(userDescription, mockConfig, abortSignal);

    const generateJsonCall = (mockClient.generateJson as Mock).mock.calls[0];
    const callParams = generateJsonCall[0];

    // Check user query (only message)
    expect(callParams.contents).toHaveLength(1);
    const userQueryContent = callParams.contents[0]?.parts?.[0]?.text;
    expect(userQueryContent).toContain(userDescription);
    expect(userQueryContent).toContain(
      'Create an agent configuration based on this request:',
    );

    // Check that system prompt is passed correctly
    expect(callParams.systemInstruction).toContain(
      'You are an elite AI agent architect',
    );
  });

  it('should throw error for null response from generateJson', async () => {
    const userDescription = 'security auditing';
    (mockClient.generateJson as Mock).mockResolvedValue(null);

    await expect(
      subagentGenerator(userDescription, mockConfig, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');
  });

  it('should throw error for undefined response from generateJson', async () => {
    const userDescription = 'api documentation';
    (mockClient.generateJson as Mock).mockResolvedValue(undefined);

    await expect(
      subagentGenerator(userDescription, mockConfig, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');
  });
});
