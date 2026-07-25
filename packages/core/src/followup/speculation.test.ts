/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  abortSpeculation,
  ensureToolResultPairing,
  startSpeculation,
} from './speculation.js';
import type { Content } from '@google/genai';
import { ApprovalMode, type Config } from '../config/config.js';

const forkedAgentMocks = vi.hoisted(() => ({
  runForkedAgent: vi.fn(),
  sendMessageStream: vi.fn(),
}));

vi.mock('../utils/forkedAgent.js', () => ({
  getCacheSafeParams: vi.fn(() => ({
    generationConfig: {},
    history: [],
    model: 'qwen-fast',
    version: 1,
  })),
  createForkedChat: vi.fn(() => ({
    sendMessageStream: forkedAgentMocks.sendMessageStream,
  })),
  runForkedAgent: forkedAgentMocks.runForkedAgent,
  runWithForkedChatModel: vi.fn(
    async (
      _config: Config,
      model: string,
      callback: (model: string) => Promise<unknown>,
    ) => callback(model),
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('startSpeculation', () => {
  it('preserves generated tool call ids in paired responses', async () => {
    const execute = vi.fn().mockResolvedValue({
      llmContent: 'file contents',
      returnDisplay: 'file contents',
    });
    const toolRegistry = {
      ensureTool: vi.fn().mockResolvedValue({
        build: vi.fn().mockReturnValue({ execute }),
      }),
    };
    const config = {
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getCwd: vi.fn().mockReturnValue(process.cwd()),
      getFastModel: vi.fn().mockReturnValue(undefined),
      getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
    } as unknown as Config;

    forkedAgentMocks.runForkedAgent.mockResolvedValue({
      jsonResult: { suggestion: '' },
    });
    forkedAgentMocks.sendMessageStream.mockImplementation(async function* () {
      if (forkedAgentMocks.sendMessageStream.mock.calls.length === 1) {
        yield {
          type: 'chunk',
          value: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call_123',
                        name: 'read_file',
                        args: { path: 'a.ts' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        };
      }
    });

    const state = await startSpeculation(config, 'read a.ts');
    await vi.waitFor(() => {
      expect(state.status).toBe('completed');
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(state.messages[1].parts?.[0].functionCall?.id).toBe('call_123');
    expect(state.messages[2].parts?.[0].functionResponse?.id).toBe('call_123');

    await abortSpeculation(state);
  });

  it.each([
    { callId: 'call_timeout', description: 'with an id' },
    { callId: undefined, description: 'without an id' },
  ])('encodes soft tool failures $description', async ({ callId }) => {
    const execute = vi.fn().mockResolvedValue({
      llmContent: 'Command timed out.\npartial output',
      returnDisplay: 'partial output',
      error: { message: 'Command timed out.', type: 'execution_timeout' },
    });
    const toolRegistry = {
      ensureTool: vi.fn().mockResolvedValue({
        build: vi.fn().mockReturnValue({ execute }),
      }),
    };
    const config = {
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getCwd: vi.fn().mockReturnValue(process.cwd()),
      getFastModel: vi.fn().mockReturnValue(undefined),
      getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
    } as unknown as Config;

    forkedAgentMocks.runForkedAgent.mockResolvedValue({
      jsonResult: { suggestion: '' },
    });
    forkedAgentMocks.sendMessageStream.mockImplementation(async function* () {
      if (forkedAgentMocks.sendMessageStream.mock.calls.length === 1) {
        yield {
          type: 'chunk',
          value: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        ...(callId ? { id: callId } : {}),
                        name: 'read_file',
                        args: { path: 'a.ts' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        };
      }
    });

    const state = await startSpeculation(config, 'run command');
    await vi.waitFor(() => expect(state.status).toBe('completed'));

    const response = state.messages[2].parts?.[0].functionResponse;
    if (callId) {
      expect(response?.id).toBe(callId);
    } else {
      expect(response).not.toHaveProperty('id');
    }
    expect(response?.response).toEqual({
      error: 'Command timed out.\npartial output',
    });
    expect(response?.response).not.toHaveProperty('output');

    await abortSpeculation(state);
  });

  it('hard-caps an aggregate speculative tool response', async () => {
    const execute = vi.fn().mockImplementation(async () => ({
      llmContent: `Tool output was too large and has been truncated${'x'.repeat(7000)}`,
      returnDisplay: 'full display',
      persistedOutputFiles: [],
    }));
    const toolRegistry = {
      ensureTool: vi.fn().mockResolvedValue({
        build: vi.fn().mockReturnValue({ execute }),
      }),
    };
    const config = {
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getCwd: vi.fn().mockReturnValue(process.cwd()),
      getFastModel: vi.fn().mockReturnValue(undefined),
      getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
      getToolOutputBatchBudget: vi.fn().mockReturnValue(10_000),
    } as unknown as Config;

    forkedAgentMocks.runForkedAgent.mockResolvedValue({
      jsonResult: { suggestion: '' },
    });
    forkedAgentMocks.sendMessageStream.mockImplementation(async function* () {
      if (forkedAgentMocks.sendMessageStream.mock.calls.length === 1) {
        yield {
          type: 'chunk',
          value: {
            candidates: [
              {
                content: {
                  parts: ['one', 'two'].map((id) => ({
                    functionCall: {
                      id,
                      name: 'read_file',
                      args: { path: `${id}.ts` },
                    },
                  })),
                },
              },
            ],
          },
        };
      }
    });

    const state = await startSpeculation(config, 'read files');
    await vi.waitFor(() => expect(state.status).toBe('completed'));

    const parts = state.messages[2].parts ?? [];
    const total = parts.reduce((sum, part) => {
      const output = part.functionResponse?.response?.['output'];
      return sum + (typeof output === 'string' ? output.length : 0);
    }, 0);
    expect(total).toBeLessThanOrEqual(10_000);
    expect(parts.map((part) => part.functionResponse?.id)).toEqual([
      'one',
      'two',
    ]);

    await abortSpeculation(state);
  });
});

describe.each([
  {
    scenario: 'same model (undefined)',
    fastModel: undefined,
    expectedPreserveTools: true,
  },
  {
    scenario: 'different model',
    fastModel: 'different-fast-model',
    expectedPreserveTools: false,
  },
])(
  'generatePipelinedSuggestion preserveTools — $scenario',
  ({ fastModel, expectedPreserveTools }) => {
    it(`passes preserveTools: ${String(expectedPreserveTools)} to runForkedAgent`, async () => {
      const config = {
        getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
        getCwd: vi.fn().mockReturnValue(process.cwd()),
        getFastModel: vi.fn().mockReturnValue(fastModel),
        getToolRegistry: vi.fn().mockReturnValue({
          ensureTool: vi.fn().mockResolvedValue({
            build: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue({
                llmContent: '',
                returnDisplay: '',
              }),
            }),
          }),
        }),
      } as unknown as Config;

      forkedAgentMocks.runForkedAgent.mockResolvedValue({
        jsonResult: { suggestion: 'next step' },
      });

      forkedAgentMocks.sendMessageStream.mockImplementation(async function* () {
        yield {
          type: 'chunk',
          value: {
            candidates: [
              {
                content: {
                  parts: [{ text: 'done' }],
                },
              },
            ],
          },
        };
      });

      const state = await startSpeculation(config, 'do something');
      await vi.waitFor(() => {
        expect(state.status).toBe('completed');
      });

      expect(forkedAgentMocks.runForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({ preserveTools: expectedPreserveTools }),
      );

      await abortSpeculation(state);
    });
  },
);

describe('ensureToolResultPairing', () => {
  it('returns empty array unchanged', () => {
    expect(ensureToolResultPairing([])).toEqual([]);
  });

  it('preserves complete messages (no function calls)', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('preserves paired functionCall + functionResponse', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'edit file' }] },
      {
        role: 'model',
        parts: [
          { text: 'editing...' },
          { functionCall: { name: 'edit', args: { file: 'a.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'edit',
              response: { output: 'done' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'file edited' }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('strips unpaired functionCalls from last model message (keeps text)', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'do something' }] },
      {
        role: 'model',
        parts: [
          { text: 'I will edit the file' },
          { functionCall: { name: 'edit', args: {} } },
        ],
      },
      // No functionResponse follows — boundary truncation
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toHaveLength(2);
    expect(result[1].parts).toEqual([{ text: 'I will edit the file' }]);
  });

  it('removes last model message entirely if only functionCalls', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'do something' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'edit', args: {} } },
          { functionCall: { name: 'shell', args: {} } },
        ],
      },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('does not modify messages when last message is user role', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'response' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool',
              response: { output: 'result' },
            },
          },
        ],
      },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('handles model message with no parts', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });
});
