/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Content } from '@google/genai';
import { BaseLlmClient } from '../core/baseLlmClient.js';
import type { ContentGenerator } from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import type { NextSpeakerResponse } from './nextSpeakerChecker.js';
import { checkNextSpeaker } from './nextSpeakerChecker.js';
import { GeminiChat } from '../core/geminiChat.js';

// Mock fs module to prevent actual file system operations during tests
const mockFileSystem = new Map<string, string>();

vi.mock('node:fs', () => {
  const fsModule = {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((path: string, data: string) => {
      mockFileSystem.set(path, data);
    }),
    readFileSync: vi.fn((path: string) => {
      if (mockFileSystem.has(path)) {
        return mockFileSystem.get(path);
      }
      throw Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
    }),
    existsSync: vi.fn((path: string) => mockFileSystem.has(path)),
    appendFileSync: vi.fn(),
  };

  return {
    default: fsModule,
    ...fsModule,
  };
});

// Mock GeminiClient and Config constructor
vi.mock('../core/baseLlmClient.js');
vi.mock('../config/config.js');

describe('checkNextSpeaker', () => {
  let chatInstance: GeminiChat;
  let mockConfig: Config;
  let mockBaseLlmClient: BaseLlmClient;
  const abortSignal = new AbortController().signal;
  const promptId = 'test-prompt-id';

  beforeEach(() => {
    vi.resetAllMocks();

    mockBaseLlmClient = new BaseLlmClient(
      {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
        countTokens: vi.fn(),
        embedContent: vi.fn(),
        useSummarizedThinking: vi.fn().mockReturnValue(false),
      } as ContentGenerator,
      {} as Config,
    );

    // Add generateJson mock to the client
    mockBaseLlmClient.generateJson = vi.fn();

    mockConfig = {
      getProjectRoot: vi.fn().mockReturnValue('/test/project/root'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getModel: () => 'test-model',
      getBaseLlmClient: vi.fn().mockReturnValue(mockBaseLlmClient),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/test/temp'),
      },
    } as unknown as Config;

    // GeminiChat will receive the mocked instances via the mocked GoogleGenAI constructor
    chatInstance = new GeminiChat(
      mockConfig,
      {},
      [], // initial history
    );

    // Spy on getHistory for chatInstance
    vi.spyOn(chatInstance, 'getHistory');
    vi.spyOn(chatInstance, 'getHistoryTail');
    vi.spyOn(chatInstance, 'getLastHistoryEntry');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockChatHistory(history: Content[]): void {
    vi.mocked(chatInstance.getHistory).mockReturnValue(history);
    vi.mocked(chatInstance.getHistoryTail).mockReturnValue(
      history.length > 0 ? [structuredClone(history[history.length - 1]!)] : [],
    );
    vi.mocked(chatInstance.getLastHistoryEntry).mockReturnValue(
      history.length > 0
        ? structuredClone(history[history.length - 1]!)
        : undefined,
    );
  }

  it('should return null if history is empty', async () => {
    mockChatHistory([]);
    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toBeNull();
    expect(mockBaseLlmClient.generateJson).not.toHaveBeenCalled();
  });

  it('should return null if the last speaker was the user', async () => {
    mockChatHistory([{ role: 'user', parts: [{ text: 'Hello' }] }]);
    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toBeNull();
    expect(mockBaseLlmClient.generateJson).not.toHaveBeenCalled();
  });

  it("should return { next_speaker: 'model' } when model intends to continue", async () => {
    mockChatHistory([
      { role: 'model', parts: [{ text: 'I will now do something.' }] },
    ] as Content[]);
    const mockApiResponse: NextSpeakerResponse = {
      reasoning: 'Model stated it will do something.',
      next_speaker: 'model',
    };
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue(mockApiResponse);

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toEqual(mockApiResponse);
    expect(mockBaseLlmClient.generateJson).toHaveBeenCalledTimes(1);
  });

  it("should return { next_speaker: 'user' } when model asks a question", async () => {
    mockChatHistory([
      { role: 'model', parts: [{ text: 'What would you like to do?' }] },
    ] as Content[]);
    const mockApiResponse: NextSpeakerResponse = {
      reasoning: 'Model asked a question.',
      next_speaker: 'user',
    };
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue(mockApiResponse);

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toEqual(mockApiResponse);
  });

  it("should return { next_speaker: 'user' } when model makes a statement", async () => {
    mockChatHistory([
      { role: 'model', parts: [{ text: 'This is a statement.' }] },
    ] as Content[]);
    const mockApiResponse: NextSpeakerResponse = {
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 'user',
    };
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue(mockApiResponse);

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toEqual(mockApiResponse);
  });

  it('should return null if baseLlmClient.generateJson throws an error', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    mockChatHistory([
      { role: 'model', parts: [{ text: 'Some model output.' }] },
    ] as Content[]);
    (mockBaseLlmClient.generateJson as Mock).mockRejectedValue(
      new Error('API Error'),
    );

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toBeNull();
    consoleWarnSpy.mockRestore();
  });

  it('should return null if baseLlmClient.generateJson returns invalid JSON (missing next_speaker)', async () => {
    mockChatHistory([
      { role: 'model', parts: [{ text: 'Some model output.' }] },
    ] as Content[]);
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue({
      reasoning: 'This is incomplete.',
    } as unknown as NextSpeakerResponse); // Type assertion to simulate invalid response

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toBeNull();
  });

  it('should return null if baseLlmClient.generateJson returns a non-string next_speaker', async () => {
    mockChatHistory([
      { role: 'model', parts: [{ text: 'Some model output.' }] },
    ] as Content[]);
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue({
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 123, // Invalid type
    } as unknown as NextSpeakerResponse);

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toBeNull();
  });

  it('should return null if baseLlmClient.generateJson returns an invalid next_speaker string value', async () => {
    mockChatHistory([
      { role: 'model', parts: [{ text: 'Some model output.' }] },
    ] as Content[]);
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue({
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 'neither', // Invalid enum value
    } as unknown as NextSpeakerResponse);

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );
    expect(result).toBeNull();
  });

  it('should call generateJson with the correct parameters', async () => {
    mockChatHistory([
      { role: 'model', parts: [{ text: 'Some model output.' }] },
    ] as Content[]);
    const mockApiResponse: NextSpeakerResponse = {
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 'user',
    };
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue(mockApiResponse);

    await checkNextSpeaker(chatInstance, mockConfig, abortSignal, promptId);

    expect(mockBaseLlmClient.generateJson).toHaveBeenCalled();
    const generateJsonCall = (mockBaseLlmClient.generateJson as Mock).mock
      .calls[0];
    expect(generateJsonCall[0].model).toBe('test-model');
    expect(generateJsonCall[0].promptId).toBe(promptId);
  });

  it('should send only the last curated model message to the side query', async () => {
    const oldHistory: Content[] = [
      { role: 'user', parts: [{ text: 'old user context'.repeat(1000) }] },
      { role: 'model', parts: [{ text: 'old model context'.repeat(1000) }] },
    ];
    const lastModelMessage: Content = {
      role: 'model',
      parts: [{ text: 'Some model output.' }],
    };
    mockChatHistory([...oldHistory, lastModelMessage]);
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue({
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 'user',
    } satisfies NextSpeakerResponse);

    await checkNextSpeaker(chatInstance, mockConfig, abortSignal, promptId);

    const generateJsonCall = (mockBaseLlmClient.generateJson as Mock).mock
      .calls[0];
    expect(generateJsonCall[0].contents).toHaveLength(2);
    expect(generateJsonCall[0].contents[0]).toEqual(lastModelMessage);
    expect(generateJsonCall[0].contents[1]).toMatchObject({
      role: 'user',
    });
    expect(chatInstance.getHistory).not.toHaveBeenCalled();
    expect(chatInstance.getHistoryTail).toHaveBeenCalledWith(1, true);
  });

  it('should use raw last history entry to detect function responses', async () => {
    vi.mocked(chatInstance.getHistoryTail).mockReturnValue([
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: {} } }],
      },
    ] as Content[]);
    vi.mocked(chatInstance.getLastHistoryEntry).mockReturnValue({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            response: { result: 'file content' },
          },
        },
      ],
    } as Content);

    const result = await checkNextSpeaker(
      chatInstance,
      mockConfig,
      abortSignal,
      promptId,
    );

    expect(result).toEqual({
      reasoning:
        'The last message was a function response, so the model should speak next.',
      next_speaker: 'model',
    });
    expect(chatInstance.getHistory).not.toHaveBeenCalled();
    expect(chatInstance.getHistoryTail).not.toHaveBeenCalled();
    expect(chatInstance.getLastHistoryEntry).toHaveBeenCalledTimes(1);
    expect(mockBaseLlmClient.generateJson).not.toHaveBeenCalled();
  });

  it('should avoid cloning comprehensive history just to inspect the last message', async () => {
    mockChatHistory([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Some model output.' }] },
    ] as Content[]);
    (mockBaseLlmClient.generateJson as Mock).mockResolvedValue({
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 'user',
    } satisfies NextSpeakerResponse);

    await checkNextSpeaker(chatInstance, mockConfig, abortSignal, promptId);

    expect(chatInstance.getHistory).not.toHaveBeenCalled();
    expect(chatInstance.getHistoryTail).toHaveBeenCalledTimes(1);
    expect(chatInstance.getHistoryTail).toHaveBeenCalledWith(1, true);
    expect(chatInstance.getLastHistoryEntry).toHaveBeenCalledTimes(1);
  });
});
