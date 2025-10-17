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
import type { Content, GoogleGenAI, Models } from '@google/genai';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import { GeminiClient } from '../core/client.js';
import { Config } from '../config/config.js';
import {
  subagentGenerator,
  type SubagentGeneratedContent,
} from './subagentGenerator.js';

// Mock GeminiClient and Config constructor
vi.mock('../core/client.js');
vi.mock('../config/config.js');

// Define mocks for GoogleGenAI and Models instances that will be used across tests
const mockModelsInstance = {
  generateContent: vi.fn(),
  generateContentStream: vi.fn(),
  countTokens: vi.fn(),
  embedContent: vi.fn(),
  batchEmbedContents: vi.fn(),
} as unknown as Models;

const mockGoogleGenAIInstance = {
  getGenerativeModel: vi.fn().mockReturnValue(mockModelsInstance),
} as unknown as GoogleGenAI;

vi.mock('@google/genai', async () => {
  const actualGenAI =
    await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ...actualGenAI,
    GoogleGenAI: vi.fn(() => mockGoogleGenAIInstance),
  };
});

describe('subagentGenerator', () => {
  let mockGeminiClient: GeminiClient;
  let MockConfig: Mock;
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    MockConfig = vi.mocked(Config);
    const mockConfigInstance = new MockConfig(
      'test-api-key',
      'gemini-pro',
      false,
      '.',
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
    );

    mockGeminiClient = new GeminiClient(mockConfigInstance);

    // Reset mocks before each test to ensure test isolation
    vi.mocked(mockModelsInstance.generateContent).mockReset();
    vi.mocked(mockModelsInstance.generateContentStream).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error for empty user description', async () => {
    await expect(
      subagentGenerator('', mockGeminiClient, abortSignal),
    ).rejects.toThrow('User description cannot be empty');

    await expect(
      subagentGenerator('   ', mockGeminiClient, abortSignal),
    ).rejects.toThrow('User description cannot be empty');

    expect(mockGeminiClient.generateJson).not.toHaveBeenCalled();
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

    (mockGeminiClient.generateJson as Mock).mockResolvedValue(mockApiResponse);

    const result = await subagentGenerator(
      userDescription,
      mockGeminiClient,
      abortSignal,
    );

    expect(result).toEqual(mockApiResponse);
    expect(mockGeminiClient.generateJson).toHaveBeenCalledTimes(1);

    // Verify the call parameters
    const generateJsonCall = (mockGeminiClient.generateJson as Mock).mock
      .calls[0];
    const contents = generateJsonCall[0] as Content[];

    // Should have 1 user message with the query
    expect(contents).toHaveLength(1);
    expect(contents[0]?.role).toBe('user');
    expect(contents[0]?.parts?.[0]?.text).toContain(
      `Create an agent configuration based on this request: "${userDescription}"`,
    );

    // Check that system prompt is passed in the config parameter
    expect(generateJsonCall[2]).toBe(abortSignal);
    expect(generateJsonCall[3]).toBe(DEFAULT_QWEN_MODEL);
    expect(generateJsonCall[4]).toEqual(
      expect.objectContaining({
        systemInstruction: expect.stringContaining(
          'You are an elite AI agent architect',
        ),
      }),
    );
  });

  it('should throw error when LLM response is missing required fields', async () => {
    const userDescription = 'help with documentation';
    const incompleteResponse = {
      name: 'doc-helper',
      description: 'Helps with documentation',
      // Missing systemPrompt
    };

    (mockGeminiClient.generateJson as Mock).mockResolvedValue(
      incompleteResponse,
    );

    await expect(
      subagentGenerator(userDescription, mockGeminiClient, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');

    expect(mockGeminiClient.generateJson).toHaveBeenCalledTimes(1);
  });

  it('should throw error when LLM response has empty fields', async () => {
    const userDescription = 'database optimization';
    const emptyFieldsResponse = {
      name: '',
      description: 'Helps with database optimization',
      systemPrompt: 'You are a database expert.',
    };

    (mockGeminiClient.generateJson as Mock).mockResolvedValue(
      emptyFieldsResponse,
    );

    await expect(
      subagentGenerator(userDescription, mockGeminiClient, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');
  });

  it('should throw error when generateJson throws an error', async () => {
    const userDescription = 'testing automation';
    (mockGeminiClient.generateJson as Mock).mockRejectedValue(
      new Error('API Error'),
    );

    await expect(
      subagentGenerator(userDescription, mockGeminiClient, abortSignal),
    ).rejects.toThrow('API Error');
  });

  it('should call generateJson with correct schema and model', async () => {
    const userDescription = 'data analysis';
    const mockResponse: SubagentGeneratedContent = {
      name: 'data-analyst',
      description: 'Analyzes data and provides insights.',
      systemPrompt: 'You are a data analysis expert.',
    };

    (mockGeminiClient.generateJson as Mock).mockResolvedValue(mockResponse);

    await subagentGenerator(userDescription, mockGeminiClient, abortSignal);

    expect(mockGeminiClient.generateJson).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          name: expect.objectContaining({ type: 'string' }),
          description: expect.objectContaining({ type: 'string' }),
          systemPrompt: expect.objectContaining({ type: 'string' }),
        }),
        required: ['name', 'description', 'systemPrompt'],
      }),
      abortSignal,
      DEFAULT_QWEN_MODEL,
      expect.objectContaining({
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

    (mockGeminiClient.generateJson as Mock).mockResolvedValue(mockResponse);

    await subagentGenerator(userDescription, mockGeminiClient, abortSignal);

    const generateJsonCall = (mockGeminiClient.generateJson as Mock).mock
      .calls[0];
    const contents = generateJsonCall[0] as Content[];

    // Check user query (only message)
    expect(contents).toHaveLength(1);
    const userQueryContent = contents[0]?.parts?.[0]?.text;
    expect(userQueryContent).toContain(userDescription);
    expect(userQueryContent).toContain(
      'Create an agent configuration based on this request:',
    );

    // Check that system prompt is passed in the config parameter
    expect(generateJsonCall[4]).toEqual(
      expect.objectContaining({
        systemInstruction: expect.stringContaining(
          'You are an elite AI agent architect',
        ),
      }),
    );
  });

  it('should throw error for null response from generateJson', async () => {
    const userDescription = 'security auditing';
    (mockGeminiClient.generateJson as Mock).mockResolvedValue(null);

    await expect(
      subagentGenerator(userDescription, mockGeminiClient, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');
  });

  it('should throw error for undefined response from generateJson', async () => {
    const userDescription = 'api documentation';
    (mockGeminiClient.generateJson as Mock).mockResolvedValue(undefined);

    await expect(
      subagentGenerator(userDescription, mockGeminiClient, abortSignal),
    ).rejects.toThrow('Invalid response from LLM: missing required fields');
  });
});
