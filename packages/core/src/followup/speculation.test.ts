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
import type { ToolResultBoundaryObservation } from '../utils/tool-result-boundary-diagnostics.js';

const forkedAgentMocks = vi.hoisted(() => ({
  runForkedAgent: vi.fn(),
  sendMessageStream: vi.fn(),
}));
const boundaryMocks = vi.hoisted(() => ({
  observe: vi.fn((_observation: ToolResultBoundaryObservation) => false),
}));

vi.mock(
  '../utils/tool-result-boundary-diagnostics.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../utils/tool-result-boundary-diagnostics.js')
    >()),
    observeToolResultBoundary: boundaryMocks.observe,
  }),
);

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
  it('stops at a boundary when the host guard denies a speculative invocation', async () => {
    const execute = vi.fn();
    const guard = vi.fn().mockResolvedValue({
      allowed: false,
      reason: 'host policy denied',
    });
    const toolRegistry = {
      ensureTool: vi.fn().mockResolvedValue({
        build: vi.fn().mockReturnValue({
          params: { path: '/normalized/a.ts' },
          execute,
        }),
      }),
    };
    const config = {
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getCwd: vi.fn().mockReturnValue(process.cwd()),
      getFastModel: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('spec-session'),
      getTargetDir: vi.fn().mockReturnValue('/spec/cwd'),
      getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
      getToolInvocationGuard: vi.fn().mockReturnValue(guard),
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
                        id: 'call-speculation-guard',
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
    await vi.waitFor(() => expect(state.status).toBe('boundary'));

    expect(guard).toHaveBeenCalledWith({
      callId: 'call-speculation-guard',
      toolName: 'read_file',
      args: { path: '/normalized/a.ts' },
      signal: expect.any(AbortSignal),
      sessionId: 'spec-session',
      cwd: '/spec/cwd',
    });
    expect(execute).not.toHaveBeenCalled();

    await abortSpeculation(state);
  });

  it('proceeds to execution when the host guard allows a speculative invocation', async () => {
    const execute = vi.fn().mockResolvedValue({
      llmContent: 'file contents',
      returnDisplay: 'file contents',
    });
    const guard = vi.fn().mockResolvedValue({ allowed: true });
    const toolRegistry = {
      ensureTool: vi.fn().mockResolvedValue({
        build: vi.fn().mockReturnValue({
          params: { path: '/normalized/a.ts' },
          execute,
        }),
      }),
    };
    const config = {
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getCwd: vi.fn().mockReturnValue(process.cwd()),
      getFastModel: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('spec-session'),
      getTargetDir: vi.fn().mockReturnValue('/spec/cwd'),
      getToolRegistry: vi.fn().mockReturnValue(toolRegistry),
      getToolInvocationGuard: vi.fn().mockReturnValue(guard),
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
                        id: 'call-speculation-guard-allow',
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
    await vi.waitFor(() => expect(state.status).toBe('completed'));

    expect(guard).toHaveBeenCalledWith({
      callId: 'call-speculation-guard-allow',
      toolName: 'read_file',
      args: { path: '/normalized/a.ts' },
      signal: expect.any(AbortSignal),
      sessionId: 'spec-session',
      cwd: '/spec/cwd',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(boundaryMocks.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'producer',
        toolCallId: 'call-speculation-guard-allow',
        toolName: 'read_file',
        values: expect.any(Function),
      }),
    );

    await abortSpeculation(state);
  });

  it('observes rejected speculative executions as terminal producers', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('execution failed'));
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
                        id: 'call-speculation-reject',
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
    await vi.waitFor(() => expect(state.status).toBe('completed'));

    const producerObservations = boundaryMocks.observe.mock.calls
      .map(([observation]) => observation)
      .filter(
        (observation) =>
          observation.stage === 'producer' &&
          observation.toolCallId === 'call-speculation-reject',
      );
    expect(producerObservations).toHaveLength(1);
    expect(producerObservations[0]).toEqual(
      expect.objectContaining({
        artifacts: [{ state: 'none', kinds: [] }],
      }),
    );
    expect(state.messages[2].parts?.[0].functionResponse?.response).toEqual({
      error: 'execution failed',
    });

    await abortSpeculation(state);
  });

  it('ignores throwing optional metadata on a speculative result', async () => {
    const result = { llmContent: 'file contents' } as {
      llmContent: string;
      artifacts?: never;
      persistedOutputFiles?: never;
    };
    Object.defineProperties(result, {
      artifacts: {
        get: () => {
          throw new Error('artifacts unavailable');
        },
      },
      persistedOutputFiles: {
        get: () => {
          throw new Error('persisted output unavailable');
        },
      },
    });
    const toolRegistry = {
      ensureTool: vi.fn().mockResolvedValue({
        build: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(result),
        }),
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
                        id: 'call-speculation-metadata',
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
    await vi.waitFor(() => expect(state.status).toBe('completed'));

    expect(state.messages[2].parts?.[0].functionResponse?.response).toEqual({
      output: 'file contents',
    });
    expect(boundaryMocks.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'producer',
        toolCallId: 'call-speculation-metadata',
        artifacts: [{ state: 'undecided', kinds: [] }],
      }),
    );

    await abortSpeculation(state);
  });

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

  it('strips speculative tool images without a vision side query', async () => {
    const execute = vi.fn().mockResolvedValue({
      llmContent: {
        inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
      },
      returnDisplay: 'captured screen',
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
                        id: 'call-image',
                        name: 'read_file',
                        args: { path: 'image.png' },
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

    const state = await startSpeculation(config, 'inspect image.png');
    await vi.waitFor(() => expect(state.status).toBe('completed'));

    const speculativeResponse = state.messages[2].parts?.[0].functionResponse;
    expect(speculativeResponse?.response?.['output']).toMatch(
      /omitted during speculative execution/i,
    );
    expect(speculativeResponse).not.toHaveProperty('parts');

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
