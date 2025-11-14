import { describe, it, expect } from 'vitest';
import { query } from '../../src/index.js';
import {
  isCLIAssistantMessage,
  isCLIResultMessage,
  isCLISystemMessage,
  type CLIUserMessage,
} from '../../src/types/protocol.js';

const TEST_CLI_PATH =
  '/Users/mingholy/Work/Projects/qwen-code/packages/cli/index.ts';
const TEST_TIMEOUT = 160000;

const SHARED_TEST_OPTIONS = {
  pathToQwenExecutable: TEST_CLI_PATH,
  permissionMode: 'yolo' as const,
};

/**
 * Factory function that creates a streaming input with a control point.
 * After the first message is yielded, the generator waits for a resume signal,
 * allowing the test code to call query instance methods like setModel or setPermissionMode.
 *
 * @param firstMessage - The first user message to send
 * @param secondMessage - The second user message to send after control operations
 * @returns Object containing the async generator and a resume function
 */
function createStreamingInputWithControlPoint(
  firstMessage: string,
  secondMessage: string,
): {
  generator: AsyncIterable<CLIUserMessage>;
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
    } as CLIUserMessage;

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
    } as CLIUserMessage;
  })();

  const resume = () => {
    if (resumeResolve) {
      resumeResolve();
    }
  };

  return { generator, resume };
}

describe('Control Request/Response (E2E)', () => {
  describe('System Controller Scope', () => {
    it(
      'should set model via control request during streaming input',
      async () => {
        const { generator, resume } = createStreamingInputWithControlPoint(
          'Tell me the model name.',
          'Tell me the model name now again.',
        );

        const q = query({
          prompt: generator,
          options: {
            ...SHARED_TEST_OPTIONS,
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
              console.log(JSON.stringify(message));
              if (isCLISystemMessage(message)) {
                systemMessages.push({ model: message.model });
              }
              if (isCLIAssistantMessage(message)) {
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
                TEST_TIMEOUT,
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
                TEST_TIMEOUT,
              ),
            ),
          ]);

          expect(secondResponseReceived).toBe(true);

          // Verify system messages - model should change from qwen3-max to qwen3-vl-plus
          expect(systemMessages.length).toBeGreaterThanOrEqual(2);
          expect(systemMessages[0].model).toBe('qwen3-max');
          expect(systemMessages[1].model).toBe('qwen3-vl-plus');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Permission Controller Scope', () => {
    it(
      'should set permission mode via control request during streaming input',
      async () => {
        const { generator, resume } = createStreamingInputWithControlPoint(
          'List files in the current directory',
          'Now read the package.json file',
        );

        const q = query({
          prompt: generator,
          options: {
            pathToQwenExecutable: TEST_CLI_PATH,
            permissionMode: 'default',
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
          let permissionModeChanged = false;
          let secondResponseReceived = false;

          // Consume messages in a single loop
          (async () => {
            for await (const message of q) {
              if (
                isCLIAssistantMessage(message) ||
                isCLIResultMessage(message)
              ) {
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
                TEST_TIMEOUT,
              ),
            ),
          ]);

          expect(firstResponseReceived).toBe(true);

          // Perform control operation: set permission mode
          await q.setPermissionMode('yolo');
          permissionModeChanged = true;

          // Resume the input stream
          resume();

          // Wait for second response
          await Promise.race([
            secondResponsePromise,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Timeout waiting for second response')),
                TEST_TIMEOUT,
              ),
            ),
          ]);

          expect(permissionModeChanged).toBe(true);
          expect(secondResponseReceived).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });
});
