/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for SDK-embedded MCP servers
 *
 * Tests that the SDK can create and manage MCP servers running in the SDK process
 * using the tool() and createSdkMcpServer() APIs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  query,
  tool,
  createSdkMcpServer,
  isSDKSystemMessage,
  type SDKMessage,
  type SDKSystemMessage,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  findToolResults,
  createSharedTestOptions,
  assertSuccessfulCompletion,
} from './test-helper.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIHandler,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  IS_CONTAINER_SANDBOX,
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
} from '../test-helper.js';

const SHARED_TEST_OPTIONS = {
  ...createSharedTestOptions(),
  permissionMode: 'yolo' as const,
};
const LOCAL_OPENAI_NO_PROXY = IS_CONTAINER_SANDBOX
  ? CONTAINER_SANDBOX_NO_PROXY
  : '127.0.0.1,localhost';
const FAKE_SERVER_OPTIONS = fakeServerHostOptions();

function fakeModelOptions(baseUrl: string) {
  return {
    model: 'fake-model',
    authType: 'openai' as const,
    env: {
      NO_PROXY: LOCAL_OPENAI_NO_PROXY,
      no_proxy: LOCAL_OPENAI_NO_PROXY,
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
    },
  };
}

function advertisedToolNames(
  fakeServer: FakeOpenAIServer,
  requestIndex: number,
): string[] {
  const tools = fakeServer.requests.filter(
    ({ body }) => body['stream'] === true,
  )[requestIndex]?.body['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((entry): string[] => {
    const name = (entry as { function?: { name?: unknown } }).function?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

// MCP tool names are generated with the pattern: mcp__<serverName>__<toolName>
const MCP_CALCULATE_SUM = 'mcp__sdk-calculator__calculate_sum';
const MCP_REVERSE_STRING = 'mcp__sdk-calculator__reverse_string';
const MCP_MAYBE_FAIL = 'mcp__sdk-error-test__maybe_fail';
const MCP_DELAYED_RESPONSE = 'mcp__sdk-async__delayed_response';

describe('SDK MCP Server Integration (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;
  let fakeResponse: FakeOpenAIHandler;
  let fakeServer: FakeOpenAIServer;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('sdk-mcp-server-integration');
    fakeResponse = () => ({ content: 'Done.' });
    fakeServer = await startFakeOpenAIServer(
      (context) => fakeResponse(context),
      FAKE_SERVER_OPTIONS,
    );
  });

  afterEach(async () => {
    await fakeServer.close();
    await helper.cleanup();
  });

  describe('Basic SDK MCP Tool Usage', () => {
    it('routes multiple tools from one SDK MCP server', async () => {
      // Define a simple calculator tool using the tool() API with Zod schema
      const calculatorTool = tool(
        'calculate_sum',
        'Calculate the sum of two numbers',
        z.object({
          a: z.number().describe('First number'),
          b: z.number().describe('Second number'),
        }).shape,
        async (args) => ({
          content: [{ type: 'text', text: String(args.a + args.b) }],
        }),
      );
      const stringTool = tool(
        'reverse_string',
        'Reverse a string',
        { text: z.string().describe('The text to reverse') },
        async (args) => ({
          content: [
            { type: 'text', text: args.text.split('').reverse().join('') },
          ],
        }),
      );

      // Create SDK MCP server with the tool
      const serverConfig = createSdkMcpServer({
        name: 'sdk-calculator',
        version: '1.0.0',
        tools: [calculatorTool, stringTool],
      });
      let streamingRequestIndex = 0;
      fakeResponse = ({ body }) => {
        if (body['stream'] !== true) {
          return { content: '{"selected_memories":[]}' };
        }
        const requestIndex = streamingRequestIndex++;
        if (requestIndex === 0) {
          return {
            toolCalls: [
              fakeToolCall('tool_search', {
                query: `select:${MCP_CALCULATE_SUM},${MCP_REVERSE_STRING}`,
              }),
            ],
          };
        }
        if (requestIndex === 1) {
          return {
            toolCalls: [
              fakeToolCall(MCP_CALCULATE_SUM, { a: 25, b: 17 }),
              fakeToolCall(MCP_REVERSE_STRING, { text: 'hello world' }),
            ],
          };
        }
        return { content: 'Done.' };
      };

      const q = query({
        prompt: 'Calculate 25 + 17, then reverse hello world.',
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          mcpServers: {
            'sdk-calculator': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];
      let systemMessage: SDKSystemMessage | null = null;

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKSystemMessage(message) && message.subtype === 'init') {
            systemMessage = message;
          }
        }

        expect(advertisedToolNames(fakeServer, 1)).toEqual(
          expect.arrayContaining([MCP_CALCULATE_SUM, MCP_REVERSE_STRING]),
        );

        const toolResults = findToolResults(messages, MCP_CALCULATE_SUM);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]?.isError).toBe(false);
        expect(toolResults[0]?.content).toContain('42');
        const stringResults = findToolResults(messages, MCP_REVERSE_STRING);
        expect(stringResults).toHaveLength(1);
        expect(stringResults[0]?.isError).toBe(false);
        expect(stringResults[0]?.content).toContain('dlrow olleh');
        expect(
          systemMessage?.mcp_servers?.some(
            (server) => server.name === 'sdk-calculator',
          ),
        ).toBe(true);
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });
  });

  describe('SDK MCP Tool Error Handling', () => {
    it('should handle tool errors gracefully', async () => {
      // Define a tool that throws an error with Zod schema
      const errorTool = tool(
        'maybe_fail',
        'A tool that may fail based on input',
        {
          shouldFail: z.boolean().describe('If true, the tool will fail'),
        },
        async (args) => {
          if (args.shouldFail) {
            throw new Error('Tool intentionally failed');
          }
          return { content: [{ type: 'text', text: 'Success!' }] };
        },
      );

      const serverConfig = createSdkMcpServer({
        name: 'sdk-error-test',
        version: '1.0.0',
        tools: [errorTool],
      });
      let streamingRequestIndex = 0;
      fakeResponse = ({ body }) => {
        if (body['stream'] !== true) {
          return { content: '{"selected_memories":[]}' };
        }
        const requestIndex = streamingRequestIndex++;
        return requestIndex === 0
          ? {
              toolCalls: [
                fakeToolCall('tool_search', {
                  query: `select:${MCP_MAYBE_FAIL}`,
                }),
              ],
            }
          : requestIndex === 1
            ? {
                toolCalls: [fakeToolCall(MCP_MAYBE_FAIL, { shouldFail: true })],
              }
            : { content: 'Done.' };
      };

      const q = query({
        prompt: 'Run the failing operation.',
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          debug: false,
          mcpServers: {
            'sdk-error-test': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        expect(advertisedToolNames(fakeServer, 1)).toContain(MCP_MAYBE_FAIL);
        const toolResults = findToolResults(messages, MCP_MAYBE_FAIL);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]?.isError).toBe(true);
        expect(toolResults[0]?.content).toContain('Tool intentionally failed');
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });
  });

  describe('Async Tool Handlers', () => {
    it('should handle async tool handlers with delays', async () => {
      // Define a tool with async delay using Zod schema
      const delayedTool = tool(
        'delayed_response',
        'Returns a value after a delay',
        {
          delay: z.number().describe('Delay in milliseconds (max 100)'),
          value: z.string().describe('Value to return'),
        },
        async (args) => {
          // Cap delay at 100ms for test performance
          const actualDelay = Math.min(args.delay, 100);
          await new Promise((resolve) => setTimeout(resolve, actualDelay));
          return {
            content: [{ type: 'text', text: `Delayed result: ${args.value}` }],
          };
        },
      );

      const serverConfig = createSdkMcpServer({
        name: 'sdk-async',
        version: '1.0.0',
        tools: [delayedTool],
      });
      let streamingRequestIndex = 0;
      fakeResponse = ({ body }) => {
        if (body['stream'] !== true) {
          return { content: '{"selected_memories":[]}' };
        }
        const requestIndex = streamingRequestIndex++;
        return requestIndex === 0
          ? {
              toolCalls: [
                fakeToolCall('tool_search', {
                  query: `select:${MCP_DELAYED_RESPONSE}`,
                }),
              ],
            }
          : requestIndex === 1
            ? {
                toolCalls: [
                  fakeToolCall(MCP_DELAYED_RESPONSE, {
                    delay: 50,
                    value: 'test_async',
                  }),
                ],
              }
            : { content: 'Done.' };
      };

      const q = query({
        prompt: 'Run the delayed operation.',
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          debug: false,
          mcpServers: {
            'sdk-async': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        expect(advertisedToolNames(fakeServer, 1)).toContain(
          MCP_DELAYED_RESPONSE,
        );
        const toolResults = findToolResults(messages, MCP_DELAYED_RESPONSE);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]?.isError).toBe(false);
        expect(toolResults[0]?.content.toLowerCase()).toMatch(/test_async/i);
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });
  });
});
