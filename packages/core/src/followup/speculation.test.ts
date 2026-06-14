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
    forkedAgentMocks.sendMessageStream.mockImplementation(
      async function* () {
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
      },
    );

    const state = await startSpeculation(config, 'read a.ts');
    await vi.waitFor(() => {
      expect(state.status).toBe('completed');
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(state.messages[1].parts?.[0].functionCall?.id).toBe('call_123');
    expect(state.messages[2].parts?.[0].functionResponse?.id).toBe(
      'call_123',
    );

    await abortSpeculation(state);
  });
});

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
