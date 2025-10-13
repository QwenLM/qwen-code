/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockClient } from './bedrockClient.js';
import type { BedrockClientConfig } from './bedrockClient.js';

// Mock AWS SDK modules
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  ConverseCommand: vi.fn(),
  ConverseStreamCommand: vi.fn(),
}));

vi.mock('@aws-sdk/credential-providers', () => ({
  fromEnv: vi.fn(
    () => () =>
      Promise.resolve({
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      }),
  ),
  fromIni: vi.fn(
    () => () =>
      Promise.resolve({
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      }),
  ),
}));

describe('BedrockClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear environment variables
    delete process.env['AWS_REGION'];
    delete process.env['AWS_PROFILE'];
  });

  describe('constructor', () => {
    it('should initialize with default region', () => {
      const client = new BedrockClient();
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should use region from config', () => {
      const config: BedrockClientConfig = {
        region: 'us-west-2',
      };
      const client = new BedrockClient(config);
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should use region from AWS_REGION environment variable', () => {
      process.env['AWS_REGION'] = 'eu-west-1';
      const client = new BedrockClient();
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should use profile from config', () => {
      const config: BedrockClientConfig = {
        profile: 'my-profile',
      };
      const client = new BedrockClient(config);
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should use profile from AWS_PROFILE environment variable', () => {
      process.env['AWS_PROFILE'] = 'test-profile';
      const client = new BedrockClient();
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should configure timeout from config', () => {
      const config: BedrockClientConfig = {
        timeout: 60000,
      };
      const client = new BedrockClient(config);
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should configure maxRetries from config', () => {
      const config: BedrockClientConfig = {
        maxRetries: 5,
      };
      const client = new BedrockClient(config);
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should handle all config options together', () => {
      const config: BedrockClientConfig = {
        region: 'ap-southeast-1',
        profile: 'production',
        timeout: 120000,
        maxRetries: 3,
      };
      const client = new BedrockClient(config);
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should handle empty config', () => {
      const client = new BedrockClient({});
      expect(client).toBeInstanceOf(BedrockClient);
    });

    it('should handle undefined config', () => {
      const client = new BedrockClient(undefined);
      expect(client).toBeInstanceOf(BedrockClient);
    });
  });

  describe('converse', () => {
    it('should call BedrockRuntimeClient.send with ConverseCommand', async () => {
      const { BedrockRuntimeClient, ConverseCommand } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Hello!' }],
          },
        },
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [
          {
            role: 'user' as const,
            content: [{ text: 'Hello' }],
          },
        ],
        inferenceConfig: {},
      };

      const response = await client.converse(request);

      expect(mockSend).toHaveBeenCalled();
      expect(ConverseCommand).toHaveBeenCalled();
      expect(response).toBeDefined();
      expect(response.output.message).toBeDefined();
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
    });

    it('should handle response with metrics', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Response' }],
          },
        },
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        metrics: {
          latencyMs: 250,
        },
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Test' }] }],
        inferenceConfig: {},
      };

      const response = await client.converse(request);

      expect(response.metrics).toBeDefined();
      expect(response.metrics?.latencyMs).toBe(250);
    });

    it('should handle response without metrics', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Response' }],
          },
        },
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        // No metrics field
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Test' }] }],
        inferenceConfig: {},
      };

      const response = await client.converse(request);

      expect(response.metrics).toBeUndefined();
    });

    it('should handle request with system messages', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Sure!' }],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Help me' }] }],
        system: [{ text: 'You are helpful' }],
        inferenceConfig: {},
      };

      await client.converse(request);

      expect(mockSend).toHaveBeenCalled();
    });

    it('should handle request with inference config', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Response' }],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Test' }] }],
        inferenceConfig: {
          maxTokens: 100,
          temperature: 0.7,
          topP: 0.9,
        },
      };

      await client.converse(request);

      expect(mockSend).toHaveBeenCalled();
    });

    it('should handle request with tools', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  toolUseId: 'tool-1',
                  name: 'get_weather',
                  input: {},
                },
              },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Weather?' }] }],
        inferenceConfig: {},
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'get_weather',
                description: 'Get weather',
                inputSchema: { json: {} },
              },
            },
          ],
        },
      };

      await client.converse(request);

      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('converseStream', () => {
    it('should yield stream events', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { messageStart: { role: 'assistant' } };
          yield {
            contentBlockStart: {
              start: { text: '' },
              contentBlockIndex: 0,
            },
          };
          yield {
            contentBlockDelta: {
              delta: { text: 'Hello' },
              contentBlockIndex: 0,
            },
          };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: 'end_turn' } };
        },
      };

      const mockSend = vi.fn().mockResolvedValue({
        stream: mockStream,
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Hi' }] }],
        inferenceConfig: {},
      };

      const events = [];
      for await (const event of client.converseStream(request)) {
        events.push(event);
      }

      expect(events.length).toBe(5);
      expect(events[0]).toHaveProperty('messageStart');
      expect(events[1]).toHaveProperty('contentBlockStart');
      expect(events[2]).toHaveProperty('contentBlockDelta');
      expect(events[3]).toHaveProperty('contentBlockStop');
      expect(events[4]).toHaveProperty('messageStop');
    });

    it('should throw error when no stream is returned', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockSend = vi.fn().mockResolvedValue({
        stream: undefined,
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Hi' }] }],
        inferenceConfig: {},
      };

      const generator = client.converseStream(request);
      await expect(generator.next()).rejects.toThrow(
        'No stream returned from Bedrock',
      );
    });

    it('should handle metadata events', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { messageStart: { role: 'assistant' } };
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              metrics: { latencyMs: 100 },
            },
          };
        },
      };

      const mockSend = vi.fn().mockResolvedValue({
        stream: mockStream,
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Test' }] }],
        inferenceConfig: {},
      };

      const events = [];
      for await (const event of client.converseStream(request)) {
        events.push(event);
      }

      expect(events.length).toBe(2);
      expect(events[1]).toHaveProperty('metadata');
      if ('metadata' in events[1]) {
        expect(events[1].metadata.usage.inputTokens).toBe(10);
      }
    });

    it('should handle tool use in stream', async () => {
      const { BedrockRuntimeClient } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { messageStart: { role: 'assistant' } };
          yield {
            contentBlockStart: {
              start: {
                toolUse: { toolUseId: 'tool-1', name: 'search', input: '' },
              },
              contentBlockIndex: 0,
            },
          };
          yield {
            contentBlockDelta: {
              delta: { toolUse: { input: '{"q":"test"}' } },
              contentBlockIndex: 0,
            },
          };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: 'tool_use' } };
        },
      };

      const mockSend = vi.fn().mockResolvedValue({
        stream: mockStream,
      });

      (
        BedrockRuntimeClient as unknown as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        send: mockSend,
      }));

      const client = new BedrockClient();
      const request = {
        modelId: 'qwen-coder',
        messages: [{ role: 'user' as const, content: [{ text: 'Search' }] }],
        inferenceConfig: {},
      };

      const events = [];
      for await (const event of client.converseStream(request)) {
        events.push(event);
      }

      expect(events.length).toBe(5);
      if ('contentBlockStart' in events[1]) {
        expect(events[1].contentBlockStart.start).toHaveProperty('toolUse');
      }
    });
  });

  describe('checkCredentials', () => {
    it('should return true when credentials are available from env', async () => {
      const { fromEnv } = await import('@aws-sdk/credential-providers');

      (fromEnv as ReturnType<typeof vi.fn>).mockReturnValue(() =>
        Promise.resolve({
          accessKeyId: 'test',
          secretAccessKey: 'secret',
        }),
      );

      const result = await BedrockClient.checkCredentials();
      expect(result).toBe(true);
    });

    it('should return true when credentials are available from profile', async () => {
      const { fromEnv, fromIni } = await import(
        '@aws-sdk/credential-providers'
      );

      (fromEnv as ReturnType<typeof vi.fn>).mockReturnValue(() =>
        Promise.reject(new Error('No env credentials')),
      );
      (fromIni as ReturnType<typeof vi.fn>).mockReturnValue(() =>
        Promise.resolve({
          accessKeyId: 'test',
          secretAccessKey: 'secret',
        }),
      );

      const result = await BedrockClient.checkCredentials();
      expect(result).toBe(true);
    });

    it('should return false when no credentials are available', async () => {
      const { fromEnv, fromIni } = await import(
        '@aws-sdk/credential-providers'
      );

      (fromEnv as ReturnType<typeof vi.fn>).mockReturnValue(() =>
        Promise.reject(new Error('No env credentials')),
      );
      (fromIni as ReturnType<typeof vi.fn>).mockReturnValue(() =>
        Promise.reject(new Error('No profile credentials')),
      );

      const result = await BedrockClient.checkCredentials();
      expect(result).toBe(false);
    });
  });
});
