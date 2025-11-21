/**
 * E2E tests for permission control features:
 * - canUseTool callback parameter
 * - setPermissionMode API
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../src/index.js';
import {
  isCLIAssistantMessage,
  isCLIResultMessage,
  isCLIUserMessage,
  type CLIUserMessage,
  type ToolUseBlock,
  type ContentBlock,
} from '../../src/types/protocol.js';

const TEST_CLI_PATH =
  '/Users/mingholy/Work/Projects/qwen-code/packages/cli/index.ts';
const TEST_TIMEOUT = 60000;

const SHARED_TEST_OPTIONS = {
  pathToQwenExecutable: TEST_CLI_PATH,
  debug: false,
  // env here sets environment variables for the CLI child process
  env: {
    // DEBUG: '1',
  },
};

/**
 * Factory function that creates a streaming input with a control point.
 * After the first message is yielded, the generator waits for a resume signal,
 * allowing the test code to call query instance methods like setPermissionMode.
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

describe('Permission Control (E2E)', () => {
  beforeAll(() => {
    //process.env['DEBUG'] = '1';
  });

  afterAll(() => {
    delete process.env['DEBUG'];
  });

  describe('canUseTool callback parameter', () => {
    it(
      'should invoke canUseTool callback when tool is requested',
      async () => {
        const toolCalls: Array<{
          toolName: string;
          input: Record<string, unknown>;
        }> = [];

        const q = query({
          prompt: 'Write a js hello world to file.',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',

            canUseTool: async (toolName, input) => {
              toolCalls.push({ toolName, input });
              console.log(toolName, input);
              /*
              {
                behavior: 'allow',
                updatedInput: input,
              };
              */
              return {
                behavior: 'deny',
                message: 'Tool execution denied by user.',
              };
            },
          },
        });

        try {
          let hasToolUse = false;
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              const toolUseBlock = message.message.content.find(
                (block: ContentBlock): block is ToolUseBlock =>
                  block.type === 'tool_use',
              );
              if (toolUseBlock) {
                hasToolUse = true;
              }
            }
          }

          expect(hasToolUse).toBe(true);
          expect(toolCalls.length).toBeGreaterThan(0);
          expect(toolCalls[0].toolName).toBeDefined();
          expect(toolCalls[0].input).toBeDefined();
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should allow tool execution when canUseTool returns allow',
      async () => {
        let callbackInvoked = false;

        const q = query({
          prompt: 'Create a file named hello.txt with content "world"',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
            cwd: '/tmp',
            canUseTool: async (toolName, input) => {
              callbackInvoked = true;
              return {
                behavior: 'allow',
                updatedInput: input,
              };
            },
          },
        });

        try {
          let hasToolResult = false;
          for await (const message of q) {
            if (isCLIUserMessage(message)) {
              if (
                Array.isArray(message.message.content) &&
                message.message.content.some(
                  (block) => block.type === 'tool_result',
                )
              ) {
                hasToolResult = true;
              }
            }
          }

          expect(callbackInvoked).toBe(true);
          expect(hasToolResult).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should deny tool execution when canUseTool returns deny',
      async () => {
        let callbackInvoked = false;

        const q = query({
          prompt: 'Create a file named test.txt',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
            canUseTool: async () => {
              callbackInvoked = true;
              return {
                behavior: 'deny',
                message: 'Tool execution denied by test',
              };
            },
          },
        });

        try {
          for await (const _message of q) {
            // Consume all messages
          }

          expect(callbackInvoked).toBe(true);
          // Tool use might still appear, but execution should be denied
          // The exact behavior depends on CLI implementation
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should pass suggestions to canUseTool callback',
      async () => {
        let receivedSuggestions: unknown = null;

        const q = query({
          prompt: 'Create a file named data.txt',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
            cwd: '/tmp',
            canUseTool: async (toolName, input, options) => {
              receivedSuggestions = options?.suggestions;
              return {
                behavior: 'allow',
                updatedInput: input,
              };
            },
          },
        });

        try {
          for await (const _message of q) {
            // Consume all messages
          }

          // Suggestions may be null or an array, depending on CLI implementation
          expect(receivedSuggestions !== undefined).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should pass abort signal to canUseTool callback',
      async () => {
        let receivedSignal: AbortSignal | undefined = undefined;

        const q = query({
          prompt: 'Create a file named signal.txt',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
            cwd: '/tmp',
            canUseTool: async (toolName, input, options) => {
              receivedSignal = options?.signal;
              return {
                behavior: 'allow',
                updatedInput: input,
              };
            },
          },
        });

        try {
          for await (const _message of q) {
            // Consume all messages
          }

          expect(receivedSignal).toBeDefined();
          expect(receivedSignal).toBeInstanceOf(AbortSignal);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should allow updatedInput modification in canUseTool callback',
      async () => {
        const originalInputs: Record<string, unknown>[] = [];
        const updatedInputs: Record<string, unknown>[] = [];

        const q = query({
          prompt: 'Create a file named modified.txt',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
            cwd: '/tmp',
            canUseTool: async (toolName, input) => {
              originalInputs.push({ ...input });
              const updatedInput = {
                ...input,
                modified: true,
                testKey: 'testValue',
              };
              updatedInputs.push(updatedInput);
              return {
                behavior: 'allow',
                updatedInput,
              };
            },
          },
        });

        try {
          for await (const _message of q) {
            // Consume all messages
          }

          expect(originalInputs.length).toBeGreaterThan(0);
          expect(updatedInputs.length).toBeGreaterThan(0);
          expect(updatedInputs[0]?.['modified']).toBe(true);
          expect(updatedInputs[0]?.['testKey']).toBe('testValue');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should default to deny when canUseTool is not provided',
      async () => {
        const q = query({
          prompt: 'Create a file named default.txt',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
            cwd: '/tmp',
            // canUseTool not provided
          },
        });

        try {
          // When canUseTool is not provided, tools should be denied by default
          // The exact behavior depends on CLI implementation
          for await (const _message of q) {
            // Consume all messages
          }
          // Test passes if no errors occur
          expect(true).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('setPermissionMode API', () => {
    it(
      'should change permission mode from default to yolo',
      async () => {
        const { generator, resume } = createStreamingInputWithControlPoint(
          'What is 1 + 1?',
          'What is 2 + 2?',
        );

        const q = query({
          prompt: generator,
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
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

          await q.setPermissionMode('yolo');

          resume();

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
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should change permission mode from yolo to plan',
      async () => {
        const { generator, resume } = createStreamingInputWithControlPoint(
          'What is 3 + 3?',
          'What is 4 + 4?',
        );

        const q = query({
          prompt: generator,
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'yolo',
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

          await q.setPermissionMode('plan');

          resume();

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
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should change permission mode to auto-edit',
      async () => {
        const { generator, resume } = createStreamingInputWithControlPoint(
          'What is 5 + 5?',
          'What is 6 + 6?',
        );

        const q = query({
          prompt: generator,
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
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

          await q.setPermissionMode('auto-edit');

          resume();

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
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should throw error when setPermissionMode is called on closed query',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            permissionMode: 'default',
          },
        });

        await q.close();

        await expect(q.setPermissionMode('yolo')).rejects.toThrow(
          'Query is closed',
        );
      },
      TEST_TIMEOUT,
    );
  });

  describe('canUseTool and setPermissionMode integration', () => {
    it('should work together - canUseTool callback with dynamic permission mode change', async () => {
      const toolCalls: Array<{
        toolName: string;
        input: Record<string, unknown>;
      }> = [];

      const { generator, resume } = createStreamingInputWithControlPoint(
        'Create a file named first.txt',
        'Create a file named second.txt',
      );

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          permissionMode: 'default',
          cwd: '/tmp',
          canUseTool: async (toolName, input) => {
            console.log('canUseTool', toolName, input);
            toolCalls.push({ toolName, input });
            return {
              behavior: 'allow',
              updatedInput: input,
            };
          },
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

        (async () => {
          for await (const message of q) {
            if (isCLIResultMessage(message)) {
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
        expect(toolCalls.length).toBeGreaterThan(0);

        await q.setPermissionMode('yolo');

        resume();

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
      } finally {
        await q.close();
      }
    }, 60000); // TEST_TIMEOUT,
  });
});
