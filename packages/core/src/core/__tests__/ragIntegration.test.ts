/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { GeminiClient } from '../client.js';
import { VectorStoreService } from '../../services/memory/vectorStoreService.js';
import { type Config } from '../../config/config.js';

// Mock dependencies
vi.mock('../../services/memory/vectorStoreService.js');

describe('RAG Integration', () => {
  let client: GeminiClient;
  let mockConfig: Config;
  let mockVectorStore: { addText: Mock; search: Mock };
  let mockContentGenerator: any;

  beforeEach(async () => {
    vi.resetAllMocks();

    mockVectorStore = {
      addText: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VectorStoreService as any).mockImplementation(() => mockVectorStore);

    mockContentGenerator = {
      generateContentStream: vi.fn().mockImplementation(async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'Response' }] } }],
          usageMetadata: { promptTokenCount: 10 }
        };
      }),
      countTokens: vi.fn().mockResolvedValue({ totalTokens: 100 }),
      embedContent: vi.fn().mockResolvedValue({ embeddings: [{ values: [0.1, 0.2] }] }),
      generateContent: vi.fn(),
    };

    mockConfig = {
      getSessionId: () => 'test-session',
      getModel: () => 'test-model',
      getProjectRoot: () => '.',
      getContentGenerator: () => mockContentGenerator,
      getChatRecordingService: () => ({
        recordUserMessage: vi.fn(),
        recordAssistantTurn: vi.fn(),
        recordChatCompression: vi.fn(),
        recordToolResult: vi.fn(),
      }),
      getToolRegistry: () => ({
        getFunctionDeclarations: () => [],
        getTool: () => null,
        getAllTools: () => [],
      }),
      getSubagentManager: () => ({ listSubagents: async () => [] }),
      getApprovalMode: () => 'default',
      getSdkMode: () => false,
      getIdeMode: () => false,
      getSkipLoopDetection: () => true,
      getSkipNextSpeakerCheck: () => true,
      getTruncateToolOutputThreshold: () => 1000,
      getTruncateToolOutputLines: () => 10,
      getEnableToolOutputTruncation: () => true,
      storage: { getProjectTempDir: () => '/tmp' },
      getUserMemory: () => '',
      getSessionTokenLimit: () => 0,
      getQuotaErrorOccurred: () => false,
      isInFallbackMode: () => false,
      getContentGeneratorConfig: () => ({}),
      getEmbeddingModel: () => 'test-embedding-model',
      getResumedSessionData: () => undefined,
      getChatCompression: () => undefined,
      getSkipStartupContext: () => true,
      getMaxSessionTurns: () => 100,
      getAllowedTools: () => [],
      getShellExecutionConfig: () => ({}),
      getGeminiClient: () => null,
    } as unknown as Config;

    client = new GeminiClient(mockConfig);
    await client.initialize();
  });

  it('should retrieve and inject context from vector store during sendMessageStream', async () => {
    const mockQuery = 'how does the parser work?';
    const mockSnippet = { text: 'The parser uses a recursive descent approach.', metadata: { path: 'parser.ts' } };
    mockVectorStore.search.mockResolvedValue([mockSnippet]);

    // We trigger a message stream
    const stream = client.sendMessageStream([{ text: mockQuery }], new AbortController().signal, 'prompt-1');
    for await (const _ of stream) { /* consume */ }

    // Verify vector store was searched with the user query
    expect(mockVectorStore.search).toHaveBeenCalledWith(mockQuery);

    // Verify that generateContentStream was called with the injected context
    const lastCall = (mockContentGenerator.generateContentStream as Mock).mock.calls[0][0];
    const systemInstructions = lastCall.contents;
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ragPart = systemInstructions.find((c: any) => 
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.parts?.some((p: any) => p.text?.includes('relevant context retrieved from your long-term memory'))
    );
    expect(ragPart).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ragPart as any).parts[0].text).toContain('The parser uses a recursive descent approach.');
  });
});
