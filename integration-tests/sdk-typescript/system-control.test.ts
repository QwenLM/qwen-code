/**
 * E2E tests for system controller features:
 * - setModel API for dynamic model switching
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  type SDKUserMessage,
} from '@qwen-code/sdk';
import { SDKTestHelper, createSharedTestOptions } from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

/**
 * Factory function that creates a streaming input with a control point.
 * After the first message is yielded, the generator waits for a resume signal,
 * allowing the test code to call query instance methods like setModel.
 *
 * @param firstMessage - The first user message to send
 * @param secondMessage - The second user message to send after control operations
 * @returns Object containing the async generator and a resume function
 */
function createStreamingInputWithControlPoint(
  firstMessage: string,
  secondMessage: string,
): {
  generator: AsyncIterable<SDKUserMessage>;
  resume: () => void;
} {
  let resumeResolve: (() => void) | null = null;
  const resumePromise = new Promise<void>((resolve) => {
    resumeResolve = resolve;
  });

  const generator = (async function* () {
    const sessionId = crypto.randomUUID();

    yield {
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: firstMessage,
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;

    await new Promise((resolve) => setTimeout(resolve, 200));

    await resumePromise;

    await new Promise((resolve) => setTimeout(resolve, 200));

    yield {
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: secondMessage,
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  })();

  const resume = () => {
    if (resumeResolve) {
      resumeResolve();
    }
  };

  return { generator, resume };
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
    it('should change model dynamically during streaming input', async () => {
      const { generator, resume } = createStreamingInputWithControlPoint(
        'Tell me the model name.',
        'Tell me the model name now again.',
      );

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          model: 'qwen3-max',
          debug: false,
        },
      });

      try {
        const resolvers: {
          first?: () => void;
          second?: () => void;
        } = {};
        const firstResponsePromise = new Promise<void>((resolve) => {
          resolvers.first = resolve;
        });
        const secondResponsePromise = new Promise<void>((resolve) => {
          resolvers.second = resolve;
        });

        let firstResponseReceived = false;
        let secondResponseReceived = false;
        const systemMessages: Array<{ model?: string }> = [];

        // Consume messages in a single loop
        (async () => {
          for await (const message of q) {
            if (isSDKSystemMessage(message)) {
              systemMessages.push({ model: message.model });
            }
            if (isSDKAssistantMessage(message)) {
              if (!firstResponseReceived) {
                firstResponseReceived = true;
                resolvers.first?.();
              } else if (!secondResponseReceived) {
                secondResponseReceived = true;
                resolvers.second?.();
              }
            }
          }
        })();

        // Wait for first response
        await Promise.race([
          firstResponsePromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Timeout waiting for first response')),
              15000,
            ),
          ),
        ]);

        expect(firstResponseReceived).toBe(true);

        // Perform control operation: set model
        await q.setModel('qwen3-vl-plus');

        // Resume the input stream
        resume();

        // Wait for second response
        await Promise.race([
          secondResponsePromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Timeout waiting for second response')),
              10000,
            ),
          ),
        ]);

        expect(secondResponseReceived).toBe(true);

        // Verify system messages - model should change from qwen3-max to qwen3-vl-plus
        expect(systemMessages.length).toBeGreaterThanOrEqual(2);
        expect(systemMessages[0].model).toBeOneOf(['qwen3-max', 'coder-model']);
        expect(systemMessages[1].model).toBe('qwen3-vl-plus');
      } finally {
        await q.close();
      }
    });

    it('should handle multiple model changes in sequence', async () => {
      const sessionId = crypto.randomUUID();
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

        await new Promise((resolve) => setTimeout(resolve, 200));
        await resumePromise1;
        await new Promise((resolve) => setTimeout(resolve, 200));

        yield {
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: 'Second message' },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 200));
        await resumePromise2;
        await new Promise((resolve) => setTimeout(resolve, 200));

        yield {
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: 'Third message' },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      })();

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          model: 'qwen3-max',
          debug: false,
        },
      });

      try {
        const systemMessages: Array<{ model?: string }> = [];
        let responseCount = 0;
        const resolvers: Array<() => void> = [];
        const responsePromises = [
          new Promise<void>((resolve) => resolvers.push(resolve)),
          new Promise<void>((resolve) => resolvers.push(resolve)),
          new Promise<void>((resolve) => resolvers.push(resolve)),
        ];

        (async () => {
          for await (const message of q) {
            if (isSDKSystemMessage(message)) {
              systemMessages.push({ model: message.model });
            }
            if (isSDKAssistantMessage(message)) {
              if (responseCount < resolvers.length) {
                resolvers[responseCount]?.();
                responseCount++;
              }
            }
          }
        })();

        // Wait for first response
        await Promise.race([
          responsePromises[0],
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout 1')), 10000),
          ),
        ]);

        // First model change
        await q.setModel('qwen3-turbo');
        resumeResolve1!();

        // Wait for second response
        await Promise.race([
          responsePromises[1],
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout 2')), 10000),
          ),
        ]);

        // Second model change
        await q.setModel('qwen3-vl-plus');
        resumeResolve2!();

        // Wait for third response
        await Promise.race([
          responsePromises[2],
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout 3')), 10000),
          ),
        ]);

        // Verify we received system messages for each model
        expect(systemMessages.length).toBeGreaterThanOrEqual(3);
        expect(systemMessages[0].model).toBeOneOf(['qwen3-max', 'coder-model']);
        expect(systemMessages[1].model).toBe('qwen3-turbo');
        expect(systemMessages[2].model).toBe('qwen3-vl-plus');
      } finally {
        await q.close();
      }
    });

    it('should throw error when setModel is called on closed query', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          model: 'qwen3-max',
        },
      });

      await q.close();

      await expect(q.setModel('qwen3-turbo')).rejects.toThrow(
        'Query is closed',
      );
    });
  });
});
