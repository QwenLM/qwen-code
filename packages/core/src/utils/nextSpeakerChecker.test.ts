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
import { LlmChat } from '../core/llm-chat.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

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

// Mock LlmClient and Config constructor
vi.mock('../core/baseLlmClient.js');
vi.mock('../config/config.js');

describe('checkNextSpeaker', () => {
  let chatInstance: LlmChat;
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
        embedContent: vi.fn(),
      } as ContentGenerator,
      {} as Config,
    );
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

    // LlmChat will receive the mocked instances via the mocked GoogleGenAI constructor
    chatInstance = new LlmChat(mockConfig, {}, [] /* initial history */);

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

  const check = () =>
    checkNextSpeaker(chatInstance, mockConfig, abortSignal, promptId);
  const generateJson = () => mockBaseLlmClient.generateJson as Mock;
  const statementResponse = (): NextSpeakerResponse => ({
    reasoning: 'Model made a statement, awaiting user input.',
    next_speaker: 'user',
  });

  /** The last history entry is a model `text`; the side query resolves `response`. */
  function modelSaid(text: string, response: unknown): void {
    mockChatHistory([modelText(text)]);
    generateJson().mockResolvedValue(response);
  }

  it('should return null if history is empty', async () => {
    mockChatHistory([]);
    expect(await check()).toBeNull();
    expect(mockBaseLlmClient.generateJson).not.toHaveBeenCalled();
  });

  it('should return null if the last speaker was the user', async () => {
    mockChatHistory([userText('Hello')]);
    expect(await check()).toBeNull();
    expect(mockBaseLlmClient.generateJson).not.toHaveBeenCalled();
  });

  it("should return { next_speaker: 'model' } when model intends to continue", async () => {
    const mockApiResponse: NextSpeakerResponse = {
      reasoning: 'Model stated it will do something.',
      next_speaker: 'model',
    };
    modelSaid('I will now do something.', mockApiResponse);

    expect(await check()).toEqual(mockApiResponse);
    expect(mockBaseLlmClient.generateJson).toHaveBeenCalledTimes(1);
  });

  it("should return { next_speaker: 'user' } when model asks a question", async () => {
    const mockApiResponse: NextSpeakerResponse = {
      reasoning: 'Model asked a question.',
      next_speaker: 'user',
    };
    modelSaid('What would you like to do?', mockApiResponse);

    expect(await check()).toEqual(mockApiResponse);
  });

  it("should return { next_speaker: 'user' } when model makes a statement", async () => {
    modelSaid('This is a statement.', statementResponse());
    expect(await check()).toEqual(statementResponse());
  });

  it('should return null if baseLlmClient.generateJson throws an error', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    mockChatHistory([modelText('Some model output.')]);
    generateJson().mockRejectedValue(new Error('API Error'));

    expect(await check()).toBeNull();
    consoleWarnSpy.mockRestore();
  });

  it('should return null if baseLlmClient.generateJson returns invalid JSON (missing next_speaker)', async () => {
    modelSaid('Some model output.', { reasoning: 'This is incomplete.' });
    expect(await check()).toBeNull();
  });

  it('should return null if baseLlmClient.generateJson returns a non-string next_speaker', async () => {
    modelSaid('Some model output.', {
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 123, // Invalid type
    });
    expect(await check()).toBeNull();
  });

  it('should return null if baseLlmClient.generateJson returns an invalid next_speaker string value', async () => {
    modelSaid('Some model output.', {
      reasoning: 'Model made a statement, awaiting user input.',
      next_speaker: 'neither', // Invalid enum value
    });
    expect(await check()).toBeNull();
  });

  it('should call generateJson with the correct parameters', async () => {
    modelSaid('Some model output.', statementResponse());

    await check();

    expect(mockBaseLlmClient.generateJson).toHaveBeenCalled();
    const generateJsonCall = generateJson().mock.calls[0];
    expect(generateJsonCall[0].model).toBe('test-model');
    expect(generateJsonCall[0].promptId).toBe(promptId);
  });

  it('should send only the last curated model message to the side query', async () => {
    const oldHistory: Content[] = [
      userText('old user context'.repeat(1000)),
      modelText('old model context'.repeat(1000)),
    ];
    const lastModelMessage: Content = modelText('Some model output.');
    mockChatHistory([...oldHistory, lastModelMessage]);
    generateJson().mockResolvedValue(statementResponse());

    await check();

    const generateJsonCall = generateJson().mock.calls[0];
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
      content('model', fnCall('read_file', {})),
    ] as Content[]);
    vi.mocked(chatInstance.getLastHistoryEntry).mockReturnValue(
      content(
        'user',
        fnResponse('read_file', { result: 'file content' }),
      ) as Content,
    );

    expect(await check()).toEqual({
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
    mockChatHistory([userText('Hello'), modelText('Some model output.')]);
    generateJson().mockResolvedValue(statementResponse());

    await check();

    expect(chatInstance.getHistory).not.toHaveBeenCalled();
    expect(chatInstance.getHistoryTail).toHaveBeenCalledTimes(1);
    expect(chatInstance.getHistoryTail).toHaveBeenCalledWith(1, true);
    expect(chatInstance.getLastHistoryEntry).toHaveBeenCalledTimes(1);
  });
});
