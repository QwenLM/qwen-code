/**
 * E2E tests for permission control features:
 * - canUseTool callback parameter
 * - setPermissionMode API
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  query,
  isSDKResultMessage,
  type SDKMessage,
  type SDKUserMessage,
} from '@qwen-code/sdk';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import {
  IS_CONTAINER_SANDBOX,
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
} from '../test-helper.js';
import {
  SDKTestHelper,
  createSharedTestOptions,
  findAllToolResultBlocks,
  hasSuccessfulToolResults,
  hasErrorToolResults,
  findSystemMessage,
  createResultWaiter,
} from './test-helper.js';

const TEST_TIMEOUT = 60000;
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

function startFakeTextServer() {
  return startFakeOpenAIServer(
    () => ({ content: 'Done.' }),
    FAKE_SERVER_OPTIONS,
  );
}

/** Returns a tool call on request 0, then plain text for all subsequent requests. */
function startFakeToolServer(toolName: string, input: Record<string, unknown>) {
  return startFakeOpenAIServer(({ requestIndex }) => {
    if (requestIndex === 0) {
      return { toolCalls: [fakeToolCall(toolName, input)] };
    }
    return { content: 'Done.' };
  }, FAKE_SERVER_OPTIONS);
}

/** True when any user message in the request body contains `text`. */
function userMessageContains(
  body: Record<string, unknown>,
  text: string,
): boolean {
  const messages =
    (body['messages'] as Array<{ role: string; content: unknown }>) ?? [];
  return messages.some(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes(text),
  );
}

/** Serves a tool call on the first request whose user messages contain `triggerText`. */
function startFakeToolServerOnMatch(
  triggerText: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  let served = false;
  return startFakeOpenAIServer(({ body }) => {
    if (!served && userMessageContains(body, triggerText)) {
      served = true;
      return { toolCalls: [fakeToolCall(toolName, input)] };
    }
    return { content: 'Done.' };
  }, FAKE_SERVER_OPTIONS);
}

/**
 * Factory function that creates a streaming input with a control point.
 * After the first message is yielded, the generator waits for a resume signal,
 * allowing the test code to call query instance methods like setPermissionMode.
 */
function createStreamingInputWithControlPoint(
  firstMessage: string,
  secondMessage: string,
  resultWaiter: { waitForResult: (index: number) => Promise<void> },
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

    await resultWaiter.waitForResult(0);

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

    await resultWaiter.waitForResult(1);
  })();

  const resume = () => {
    if (resumeResolve) {
      resumeResolve();
    }
  };

  return { generator, resume };
}

describe('Permission Control (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeAll(() => {
    //process.env['DEBUG'] = '1';
  });

  afterAll(() => {
    delete process.env['DEBUG'];
  });

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('permission-control');
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('canUseTool callback parameter', () => {
    it('should invoke canUseTool callback and deny tool execution', async () => {
      const toolCalls: Array<{
        toolName: string;
        input: Record<string, unknown>;
      }> = [];
      const fileName = 'denied.txt';
      const input = {
        file_path: helper.getPath(fileName),
        content: 'denied',
      };
      const fakeServer = await startFakeToolServer('write_file', input);

      const q = query({
        prompt: `Create ${fileName}.`,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          permissionMode: 'default',
          cwd: testDir,
          coreTools: ['write_file'],
          canUseTool: async (toolName, input) => {
            toolCalls.push({ toolName, input });
            return {
              behavior: 'deny',
              message: 'Tool execution denied by user.',
            };
          },
        },
      });

      try {
        const messages: SDKMessage[] = [];
        for await (const message of q) {
          messages.push(message);
        }

        expect(toolCalls).toEqual([{ toolName: 'write_file', input }]);
        expect(hasErrorToolResults(messages)).toBe(true);
        expect(helper.fileExists(fileName)).toBe(false);
      } finally {
        await q.close();
        await fakeServer.close();
      }
    });

    it('should allow tool execution when canUseTool returns allow', async () => {
      let callbackInvoked = false;
      const fileName = 'hello.txt';
      const fakeServer = await startFakeToolServer('write_file', {
        file_path: helper.getPath(fileName),
        content: 'world',
      });

      const q = query({
        prompt: `Create ${fileName}.`,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          permissionMode: 'default',
          cwd: testDir,
          coreTools: ['write_file'],
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
        const messages: SDKMessage[] = [];
        for await (const message of q) {
          messages.push(message);
        }

        expect(callbackInvoked).toBe(true);
        expect(hasSuccessfulToolResults(messages)).toBe(true);
        await expect(helper.readFile(fileName)).resolves.toBe('world');
      } finally {
        await q.close();
        await fakeServer.close();
      }
    });

    it('should pass suggestions to canUseTool callback', async () => {
      let receivedSuggestions: unknown;
      const fakeServer = await startFakeToolServer('write_file', {
        file_path: helper.getPath('data.txt'),
        content: 'data',
      });

      const q = query({
        prompt: 'Create data.txt.',
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          permissionMode: 'default',
          cwd: testDir,
          coreTools: ['write_file'],
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
          // Consume all messages.
        }

        expect(receivedSuggestions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'allow' }),
            expect.objectContaining({ type: 'deny' }),
          ]),
        );
      } finally {
        await q.close();
        await fakeServer.close();
      }
    });

    it('should pass abort signal to canUseTool callback', async () => {
      let receivedSignal: AbortSignal | undefined = undefined;

      // Drive the turn with a fake model that deterministically requests a
      // write_file call. In default mode write_file requires permission, so
      // canUseTool always fires — a real model may answer in text and never
      // invoke the callback, which is the flake this guards against.
      const fakeServer = await startFakeToolServer('write_file', {
        file_path: helper.getPath('signal.txt'),
        content: 'signal test',
      });

      const q = query({
        prompt: 'Create a file named signal.txt',
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          permissionMode: 'default',
          cwd: testDir,
          coreTools: ['write_file'],
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
        await fakeServer.close();
      }
    });
  });

  describe('setPermissionMode API', () => {
    it('should continue after changing permission mode from default to yolo', async () => {
      const fakeServer = await startFakeTextServer();
      const resultWaiter = createResultWaiter(2);
      const { generator, resume } = createStreamingInputWithControlPoint(
        'What is 1 + 1?',
        'What is 2 + 2?',
        resultWaiter,
      );

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          permissionMode: 'default',
          debug: true,
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
            if (isSDKResultMessage(message)) {
              // Resolve on result (one per turn), not assistant message
              // (which may fire multiple times per turn: thinking + text)
              if (!firstResponseReceived) {
                firstResponseReceived = true;
                resolvers.first?.();
              } else if (!secondResponseReceived) {
                secondResponseReceived = true;
                resolvers.second?.();
              }
              resultWaiter.notifyResult();
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
        await fakeServer.close();
      }
    });

    it('should block write tools after changing permission mode from yolo to plan', async () => {
      const fileName = 'plan-after-switch.txt';
      const fakeServer = await startFakeToolServerOnMatch(
        `Create ${fileName}`,
        'write_file',
        { file_path: helper.getPath(fileName), content: 'should be blocked' },
      );
      const resultWaiter = createResultWaiter(2);
      const { generator, resume } = createStreamingInputWithControlPoint(
        'Hello',
        `Create ${fileName}.`,
        resultWaiter,
      );

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          permissionMode: 'yolo',
          coreTools: ['write_file'],
          canUseTool: async (_toolName, input) => ({
            behavior: 'allow',
            updatedInput: input,
          }),
        },
      });

      try {
        const messages: SDKMessage[] = [];
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
            messages.push(message);
            if (isSDKResultMessage(message)) {
              // Resolve on result (one per turn), not assistant message
              // (which may fire multiple times per turn: thinking + text)
              if (!firstResponseReceived) {
                firstResponseReceived = true;
                resolvers.first?.();
              } else if (!secondResponseReceived) {
                secondResponseReceived = true;
                resolvers.second?.();
              }
              resultWaiter.notifyResult();
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
        expect(hasErrorToolResults(messages)).toBe(true);
        expect(helper.fileExists(fileName)).toBe(false);
      } finally {
        await q.close();
        await fakeServer.close();
      }
    });

    it('should auto-approve write tools after changing permission mode to auto-edit', async () => {
      let callbackInvoked = false;
      const fileName = 'auto-edit-after-switch.txt';
      const fakeServer = await startFakeToolServerOnMatch(
        `Create ${fileName}`,
        'write_file',
        { file_path: helper.getPath(fileName), content: 'auto-edit works' },
      );
      const resultWaiter = createResultWaiter(2);
      const { generator, resume } = createStreamingInputWithControlPoint(
        'Hello',
        `Create ${fileName}.`,
        resultWaiter,
      );

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          cwd: testDir,
          permissionMode: 'default',
          coreTools: ['write_file'],
          canUseTool: async (_toolName, input) => {
            callbackInvoked = true;
            return {
              behavior: 'allow',
              updatedInput: input,
            };
          },
        },
      });

      try {
        const messages: SDKMessage[] = [];
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
            messages.push(message);
            if (isSDKResultMessage(message)) {
              // Resolve on result (one per turn), not assistant message
              // (which may fire multiple times per turn: thinking + text)
              if (!firstResponseReceived) {
                firstResponseReceived = true;
                resolvers.first?.();
              } else if (!secondResponseReceived) {
                secondResponseReceived = true;
                resolvers.second?.();
              }
              resultWaiter.notifyResult();
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
        expect(hasSuccessfulToolResults(messages)).toBe(true);
        expect(callbackInvoked).toBe(false);
        await expect(helper.readFile(fileName)).resolves.toBe(
          'auto-edit works',
        );
      } finally {
        await q.close();
        await fakeServer.close();
      }
    });

    it('should throw error when setPermissionMode is called on closed query', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          permissionMode: 'default',
          timeout: {
            /**
             * We use a short control request timeout and
             * wait till the time exceeded to test if
             * an immediate close() will raise an query close
             * error and no other uncaught timeout error
             */
            controlRequest: 5000,
          },
        },
      });

      await q.close();

      await expect(q.setPermissionMode('yolo')).rejects.toThrow(
        'Query is closed',
      );

      await new Promise((resolve) => setTimeout(resolve, 8000));
    }, 15_000);
  });

  describe('canUseTool and setPermissionMode integration', () => {
    it('should stop invoking canUseTool after changing to yolo mode', async () => {
      const toolCalls: Array<{
        toolName: string;
        input: Record<string, unknown>;
      }> = [];
      const firstFile = 'first.txt';
      const secondFile = 'second.txt';
      const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
        // Turn 1 consumes requests 0 (tool call) and 1 ('Done.'), so turn 2's
        // tool call is request 2. Absolute indexing is deliberate: the fake
        // server never retries, so an extra model request means the protocol
        // sequence changed and this test should fail loudly rather than drift.
        if (requestIndex === 0) {
          return {
            toolCalls: [
              fakeToolCall('write_file', {
                file_path: helper.getPath(firstFile),
                content: 'first',
              }),
            ],
          };
        }
        if (requestIndex === 2) {
          return {
            toolCalls: [
              fakeToolCall('write_file', {
                file_path: helper.getPath(secondFile),
                content: 'second',
              }),
            ],
          };
        }
        return { content: 'Done.' };
      }, FAKE_SERVER_OPTIONS);

      const resultWaiter = createResultWaiter(2);
      const { generator, resume } = createStreamingInputWithControlPoint(
        `Create ${firstFile}.`,
        `Create ${secondFile}.`,
        resultWaiter,
      );

      const q = query({
        prompt: generator,
        options: {
          ...SHARED_TEST_OPTIONS,
          ...fakeModelOptions(fakeServer.baseUrl),
          permissionMode: 'default',
          cwd: testDir,
          coreTools: ['write_file'],
          canUseTool: async (toolName, input) => {
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
            if (isSDKResultMessage(message)) {
              if (!firstResponseReceived) {
                firstResponseReceived = true;
                resolvers.first?.();
              } else if (!secondResponseReceived) {
                secondResponseReceived = true;
                resolvers.second?.();
              }
              resultWaiter.notifyResult();
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
        expect(toolCalls).toHaveLength(1);
        await expect(helper.readFile(firstFile)).resolves.toBe('first');

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
        expect(fakeServer.requests).toHaveLength(4);
        expect(toolCalls).toHaveLength(1);
        await expect(helper.readFile(secondFile)).resolves.toBe('second');
      } finally {
        await q.close();
        await fakeServer.close();
      }
    });
  });

  describe('ApprovalMode behavior tests', () => {
    describe('default mode', () => {
      it(
        'should auto-deny tools requiring confirmation without canUseTool callback',
        async () => {
          const fileName = 'test-default-deny.txt';
          const fakeServer = await startFakeToolServer('write_file', {
            file_path: helper.getPath(fileName),
            content: 'hello',
          });
          const q = query({
            prompt: `Create ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'default',
              cwd: testDir,
              coreTools: ['write_file'],
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasErrorToolResults(messages)).toBe(true);
            const errorResults = findAllToolResultBlocks(messages).filter(
              (r) => r.isError,
            );
            expect(errorResults[0].content.toLowerCase()).toContain('denied');
            expect(helper.fileExists(fileName)).toBe(false);
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );

      it(
        'should execute read-only tools without confirmation',
        async () => {
          const fileName = 'read-only-test.txt';
          await helper.createFile(fileName, 'content for read-only test');
          const fakeServer = await startFakeToolServer('read_file', {
            file_path: helper.getPath(fileName),
          });

          const q = query({
            prompt: `Read ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'default',
              cwd: testDir,
              coreTools: ['read_file'],
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasSuccessfulToolResults(messages)).toBe(true);
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );
    });

    describe('yolo mode', () => {
      it(
        'should auto-approve tools without invoking canUseTool callback',
        async () => {
          let callbackInvoked = false;
          const fileName = 'test-yolo-no-callback.txt';
          const fakeServer = await startFakeToolServer('write_file', {
            file_path: helper.getPath(fileName),
            content: 'yolo',
          });

          const q = query({
            prompt: `Create ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'yolo',
              cwd: testDir,
              coreTools: ['write_file'],
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
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasSuccessfulToolResults(messages)).toBe(true);
            expect(callbackInvoked).toBe(false);
            await expect(helper.readFile(fileName)).resolves.toBe('yolo');
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );

      it(
        'should execute shell commands without confirmation in yolo mode',
        async () => {
          const fakeServer = await startFakeToolServer('run_shell_command', {
            command: 'echo "dangerous operation"',
          });

          const q = query({
            prompt: 'Run command: echo "dangerous operation"',
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'yolo',
              cwd: testDir,
              coreTools: ['run_shell_command'],
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasSuccessfulToolResults(messages)).toBe(true);
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );
    });

    describe('plan mode', () => {
      it(
        'should have permission_mode set to plan in system message',
        async () => {
          const fakeServer = await startFakeTextServer();
          const q = query({
            prompt: 'List files in the current directory',
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'plan',
              cwd: testDir,
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            const systemMessage = findSystemMessage(messages, 'init');
            expect(systemMessage).not.toBeNull();
            expect(systemMessage!.permission_mode).toBe('plan');
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );

      it(
        'should block write tools in plan mode',
        async () => {
          const fileName = 'test-plan-write.txt';
          const fakeServer = await startFakeToolServer('write_file', {
            file_path: helper.getPath(fileName),
            content: 'blocked',
          });

          const q = query({
            prompt: `Create ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'plan',
              cwd: testDir,
              coreTools: ['write_file'],
              canUseTool: async (_toolName, input) => ({
                behavior: 'allow',
                updatedInput: input,
              }),
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasErrorToolResults(messages)).toBe(true);
            const errorResults = findAllToolResultBlocks(messages).filter(
              (r) => r.isError,
            );
            expect(errorResults[0].content.toLowerCase()).toContain(
              'plan mode',
            );
            expect(helper.fileExists(fileName)).toBe(false);
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );

      it(
        'should block edit tool in plan mode',
        async () => {
          const fileName = 'test-plan-edit.txt';
          await helper.createFile(fileName, 'old content');
          const filePath = helper.getPath(fileName);
          // Read the file first so prior-read enforcement passes and the
          // plan-mode policy is the gate that actually blocks the edit.
          const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
            if (requestIndex === 0) {
              return {
                toolCalls: [fakeToolCall('read_file', { file_path: filePath })],
              };
            }
            if (requestIndex === 1) {
              return {
                toolCalls: [
                  fakeToolCall('edit', {
                    file_path: filePath,
                    old_string: 'old',
                    new_string: 'new',
                  }),
                ],
              };
            }
            return { content: 'Done.' };
          }, FAKE_SERVER_OPTIONS);

          const q = query({
            prompt: `Edit ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'plan',
              cwd: testDir,
              coreTools: ['read_file', 'edit'],
              canUseTool: async (_toolName, input) => ({
                behavior: 'allow',
                updatedInput: input,
              }),
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasErrorToolResults(messages)).toBe(true);
            const errorResults = findAllToolResultBlocks(messages).filter(
              (r) => r.isError,
            );
            expect(errorResults[0].content.toLowerCase()).toContain(
              'plan mode',
            );
            await expect(helper.readFile(fileName)).resolves.toBe(
              'old content',
            );
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );

      it(
        'should block run_shell_command in plan mode',
        async () => {
          const fakeServer = await startFakeToolServer('run_shell_command', {
            command: 'touch plan-shell-blocked.txt',
          });

          const q = query({
            prompt: 'Run touch plan-shell-blocked.txt.',
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'plan',
              cwd: testDir,
              coreTools: ['run_shell_command'],
              canUseTool: async (_toolName, input) => ({
                behavior: 'allow',
                updatedInput: input,
              }),
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasErrorToolResults(messages)).toBe(true);
            const errorResults = findAllToolResultBlocks(messages).filter(
              (r) => r.isError,
            );
            expect(errorResults[0].content.toLowerCase()).toContain(
              'plan mode',
            );
            expect(helper.fileExists('plan-shell-blocked.txt')).toBe(false);
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );

      it(
        'should allow read tools without invoking canUseTool callback',
        async () => {
          let callbackInvoked = false;
          const fileName = 'test-plan-read.txt';
          await helper.createFile(fileName, 'plan read');
          const fakeServer = await startFakeToolServer('read_file', {
            file_path: helper.getPath(fileName),
          });

          const q = query({
            prompt: `Read ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'plan',
              cwd: testDir,
              coreTools: ['read_file'],
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
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasSuccessfulToolResults(messages)).toBe(true);
            expect(callbackInvoked).toBe(false);
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );
    });

    describe('auto-edit mode', () => {
      it(
        'should auto-approve write tools without invoking canUseTool callback',
        async () => {
          let callbackInvoked = false;
          const fileName = 'test-auto-edit-no-callback.txt';
          const fakeServer = await startFakeToolServer('write_file', {
            file_path: helper.getPath(fileName),
            content: 'auto-edit callback test',
          });

          const q = query({
            prompt: `Create ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              permissionMode: 'auto-edit',
              cwd: testDir,
              coreTools: ['write_file'],
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
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasSuccessfulToolResults(messages)).toBe(true);
            expect(callbackInvoked).toBe(false);
            await expect(helper.readFile(fileName)).resolves.toBe(
              'auto-edit callback test',
            );
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );

      it(
        'should execute read-only tools without confirmation',
        async () => {
          const fileName = 'test-read-file.txt';
          await helper.createFile(
            fileName,
            'This is a test file for read-only tool verification.',
          );
          const fakeServer = await startFakeToolServer('read_file', {
            file_path: helper.getPath(fileName),
          });

          const q = query({
            prompt: `Read ${fileName}.`,
            options: {
              ...SHARED_TEST_OPTIONS,
              ...fakeModelOptions(fakeServer.baseUrl),
              cwd: testDir,
              permissionMode: 'auto-edit',
              coreTools: ['read_file'],
            },
          });

          try {
            const messages: SDKMessage[] = [];
            for await (const message of q) {
              messages.push(message);
            }

            expect(hasSuccessfulToolResults(messages)).toBe(true);
          } finally {
            await q.close();
            await fakeServer.close();
          }
        },
        TEST_TIMEOUT,
      );
    });
  });
});
