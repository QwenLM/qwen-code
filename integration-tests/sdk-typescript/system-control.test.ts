/**
 * E2E tests for system controller features:
 * - setModel API for dynamic model switching
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKSystemMessage,
  isSDKResultMessage,
  type SDKUserMessage,
} from '@qwen-code/sdk';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import {
  IS_CONTAINER_SANDBOX,
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
} from '../test-helper.js';
import {
  SDKTestHelper,
  createSharedTestOptions,
  createResultWaiter,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();
const LOCAL_OPENAI_NO_PROXY = IS_CONTAINER_SANDBOX
  ? CONTAINER_SANDBOX_NO_PROXY
  : '127.0.0.1,localhost';
const FAKE_SERVER_OPTIONS = fakeServerHostOptions();
const RESPONSE_TIMEOUT_MS = process.env['CI'] ? 60000 : 30000;

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

describe('System Control (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('system-control');
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('setModel API', () => {
    it('should handle multiple model changes in sequence', async () => {
      const fakeServer = await startFakeOpenAIServer(
        () => ({ content: 'Done.' }),
        FAKE_SERVER_OPTIONS,
      );
      const sessionId = crypto.randomUUID();
      const resultWaiter = createResultWaiter(3);
      let resumeResolve1: (() => void) | null = null;
      let resumeResolve2: (() => void) | null = null;
      const resumePromise1 = new Promise<void>((resolve) => {
        resumeResolve1 = resolve;
      });
      const resumePromise2 = new Promise<void>((resolve) => {
        resumeResolve2 = resolve;
      });

      const generator = (async function* () {
        yield {
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: 'First message' },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await resultWaiter.waitForResult(0);
        await resumePromise1;
        await new Promise((resolve) => setTimeout(resolve, 200));

        yield {
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: 'Second message' },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await resultWaiter.waitForResult(1);
        await resumePromise2;
        await new Promise((resolve) => setTimeout(resolve, 200));

        yield {
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: 'Third message' },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await resultWaiter.waitForResult(2);
      })();

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          debug: false,
        },
      });

      try {
        const systemMessages: Array<{ model?: string }> = [];
        let turnCount = 0;
        const resolvers: Array<() => void> = [];
        const responsePromises = [
          new Promise<void>((resolve) => resolvers.push(resolve)),
          new Promise<void>((resolve) => resolvers.push(resolve)),
          new Promise<void>((resolve) => resolvers.push(resolve)),
        ];

        const messageConsumer = (async () => {
          for await (const message of q) {
            if (isSDKSystemMessage(message)) {
              systemMessages.push({ model: message.model });
            }
            if (isSDKResultMessage(message)) {
              resultWaiter.notifyResult();
              // Resolve on result (one per turn), not assistant message
              // (which may fire multiple times per turn: thinking + text)
              if (turnCount < resolvers.length) {
                resolvers[turnCount]?.();
                turnCount++;
              }
            }
          }
        })();

        // Wait for first response
        await Promise.race([
          responsePromises[0],
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Timeout 1')),
              RESPONSE_TIMEOUT_MS,
            ),
          ),
        ]);
        // First model change
        await q.setModel('fake-model-2');
        resumeResolve1!();

        // Wait for second response
        await Promise.race([
          responsePromises[1],
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Timeout 2')),
              RESPONSE_TIMEOUT_MS,
            ),
          ),
        ]);

        // Second model change
        await q.setModel('fake-model-3');
        resumeResolve2!();

        // Wait for third response
        await Promise.race([
          responsePromises[2],
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Timeout 3')),
              RESPONSE_TIMEOUT_MS,
            ),
          ),
        ]);
        await messageConsumer;

        // Verify we received system messages for each model
        expect(systemMessages.length).toBeGreaterThanOrEqual(3);
        expect(systemMessages[0].model).toBe('fake-model');
        expect(systemMessages[1].model).toBe('fake-model-2');
        expect(systemMessages[2].model).toBe('fake-model-3');
        const requestModels = fakeServer.requests
          .filter(({ body }) => body['stream'] === true)
          .map(({ body }) => body['model']);
        expect(
          requestModels.filter(
            (model, index) => index === 0 || model !== requestModels[index - 1],
          ),
        ).toEqual(['fake-model', 'fake-model-2', 'fake-model-3']);
      } finally {
        await q.close();
        await fakeServer.close();
      }
    });

    it('should throw error when setModel is called on closed query', async () => {
      const fakeServer = await startFakeOpenAIServer(
        () => ({ content: 'Done.' }),
        FAKE_SERVER_OPTIONS,
      );
      try {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
          },
        });

        await q.close();

        await expect(q.setModel('fake-model-2')).rejects.toThrow(
          'Query is closed',
        );
      } finally {
        await fakeServer.close();
      }
    });
  });

  describe('supportedCommands API', () => {
    it('should return list of supported slash commands', async () => {
      const fakeServer = await startFakeOpenAIServer(
        () => ({ content: 'Done.' }),
        FAKE_SERVER_OPTIONS,
      );
      const sessionId = crypto.randomUUID();
      const resultWaiter = createResultWaiter(1);
      const generator = (async function* () {
        yield {
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: 'Hello' },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await resultWaiter.waitForResult(0);
      })();

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          debug: false,
        },
      });

      try {
        const result = await q.supportedCommands();
        // Start consuming messages to trigger initialization
        const messageConsumer = (async () => {
          try {
            for await (const _message of q) {
              if (isSDKResultMessage(_message)) {
                resultWaiter.notifyResult();
              }
              // Just consume messages
            }
          } catch (error) {
            // Ignore errors from query being closed
            if (error instanceof Error && error.message !== 'Query is closed') {
              throw error;
            }
          }
        })();

        // Verify result structure
        expect(result).toBeDefined();
        expect(result).toHaveProperty('commands');
        expect(Array.isArray(result?.['commands'])).toBe(true);

        const commands = result?.['commands'] as string[];

        // Verify default allowed built-in commands are present
        expect(commands).toContain('init');
        expect(commands).toContain('summary');
        expect(commands).toContain('compress');

        // Verify commands are sorted
        const sortedCommands = [...commands].sort();
        expect(commands).toEqual(sortedCommands);

        // Verify all commands are strings
        commands.forEach((cmd) => {
          expect(typeof cmd).toBe('string');
          expect(cmd.length).toBeGreaterThan(0);
        });

        await q.close();
        await messageConsumer;
      } catch (error) {
        await q.close();
        throw error;
      } finally {
        await fakeServer.close();
      }
    });

    it('should throw error when supportedCommands is called on closed query', async () => {
      const fakeServer = await startFakeOpenAIServer(
        () => ({ content: 'Done.' }),
        FAKE_SERVER_OPTIONS,
      );
      try {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
          },
        });

        await q.close();

        await expect(q.supportedCommands()).rejects.toThrow('Query is closed');
      } finally {
        await fakeServer.close();
      }
    });
  });
});
