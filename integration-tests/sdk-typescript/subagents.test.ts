/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  type SDKMessage,
  type SubagentConfig,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  createSharedTestOptions,
  findToolUseBlocks,
  findToolResults,
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

const SHARED_TEST_OPTIONS = createSharedTestOptions();
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

describe('Subagents (E2E)', () => {
  let helper: SDKTestHelper;
  let testWorkDir: string;
  let fakeResponse: FakeOpenAIHandler;
  let fakeServer: FakeOpenAIServer;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testWorkDir = await helper.setup('subagent-tests');
    await helper.createFile('test.txt', 'Hello from test file\n');
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

  it('registers multiple session-level subagents', async () => {
    const agents: SubagentConfig[] = [
      {
        name: 'greeter',
        description: 'Responds to greetings',
        systemPrompt: 'You are a friendly greeter.',
        level: 'session',
      },
      {
        name: 'math-helper',
        description: 'Helps with math problems',
        systemPrompt: 'You are a math expert.',
        level: 'session',
      },
    ];
    const q = query({
      prompt: 'Hello',
      options: {
        ...SHARED_TEST_OPTIONS,
        ...fakeModelOptions(fakeServer.baseUrl),
        cwd: testWorkDir,
        agents,
      },
    });

    try {
      for await (const message of q) {
        if (isSDKSystemMessage(message) && message.subtype === 'init') {
          expect(message.agents).toEqual(
            expect.arrayContaining(['greeter', 'math-helper']),
          );
          return;
        }
      }
      throw new Error('Missing init message');
    } finally {
      await q.close();
    }
  });

  it('delegates a file read to a tool-restricted subagent', async () => {
    const fileReaderAgent: SubagentConfig = {
      name: 'file-reader',
      description: 'Reads a requested file and reports its exact contents.',
      systemPrompt: 'Read the requested file and report its exact contents.',
      level: 'session',
      tools: ['read_file'],
    };
    const testFile = helper.getPath('test.txt');
    let sentReadFile = false;
    let subagentToolNames: string[] = [];
    let streamingRequestIndex = 0;
    fakeResponse = ({ body }) => {
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      const requestIndex = streamingRequestIndex++;
      if (requestIndex === 0) {
        return {
          toolCalls: [
            fakeToolCall('agent', {
              description: 'Read test file',
              prompt: `Read ${testFile} and return its exact contents.`,
              subagent_type: 'file-reader',
              run_in_background: false,
            }),
          ],
        };
      }
      const toolNames = Array.isArray(body['tools'])
        ? body['tools']
            .map(
              (tool) =>
                (tool as { function?: { name?: unknown } }).function?.name,
            )
            .filter((name): name is string => typeof name === 'string')
        : [];
      if (!sentReadFile && toolNames.includes('read_file')) {
        sentReadFile = true;
        subagentToolNames = toolNames;
        return {
          toolCalls: [fakeToolCall('read_file', { file_path: testFile })],
        };
      }
      return { content: 'Done.' };
    };
    const q = query({
      prompt: `Ask the file-reader subagent to read ${testFile}.`,
      options: {
        ...SHARED_TEST_OPTIONS,
        ...fakeModelOptions(fakeServer.baseUrl),
        cwd: testWorkDir,
        agents: [fileReaderAgent],
        permissionMode: 'yolo',
      },
    });

    const messages: SDKMessage[] = [];
    let agentToolUseId: string | undefined;
    let readFileParentToolUseId: string | null | undefined;

    try {
      for await (const message of q) {
        messages.push(message);
        if (!isSDKAssistantMessage(message)) continue;

        const agentToolUse = findToolUseBlocks(message, 'agent')[0];
        if (agentToolUse) agentToolUseId = agentToolUse.id;

        if (findToolUseBlocks(message, 'read_file').length > 0) {
          readFileParentToolUseId = message.parent_tool_use_id;
        }
      }

      expect(
        fakeServer.requests.find(({ body }) => body['stream'] === true)?.body[
          'tools'
        ],
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({
              name: 'agent',
              description: expect.stringContaining('file-reader'),
            }),
          }),
        ]),
      );
      expect(agentToolUseId).toBeDefined();
      expect(readFileParentToolUseId).toBe(agentToolUseId);
      const readResults = findToolResults(messages, 'read_file');
      expect(readResults).toHaveLength(1);
      expect(readResults[0]?.isError).toBe(false);
      expect(readResults[0]?.content).toContain('Hello from test file');

      expect(subagentToolNames).toContain('read_file');
      expect(subagentToolNames).not.toContain('write_file');
      assertSuccessfulCompletion(messages);
    } finally {
      await q.close();
    }
  });

  it('accepts an empty subagent array', async () => {
    const q = query({
      prompt: 'Hello',
      options: {
        ...SHARED_TEST_OPTIONS,
        ...fakeModelOptions(fakeServer.baseUrl),
        cwd: testWorkDir,
        agents: [],
      },
    });

    try {
      for await (const message of q) {
        if (isSDKSystemMessage(message) && message.subtype === 'init') {
          expect(message.agents).toEqual([]);
          return;
        }
      }
      throw new Error('Missing init message');
    } finally {
      await q.close();
    }
  });
});
