/**
 * E2E tests based on abort-and-lifecycle.ts example
 * Tests AbortController integration and process lifecycle management
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  AbortError,
  isAbortError,
  isSDKAssistantMessage,
  isSDKPartialAssistantMessage,
  isSDKResultMessage,
  type TextBlock,
  type SDKUserMessage,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  createSharedTestOptions,
  createResultWaiter,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

describe('AbortController and Process Lifecycle (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('abort-and-lifecycle');
  });

  afterEach(async () => {
    await helper.cleanup();
  });
  describe('Basic AbortController Usage', () => {
    it('should support AbortController cancellation', async () => {
      const controller = new AbortController();
      const TARGET_CHARS = 50;
      let accumulatedText = '';

      const q = query({
        prompt: 'Write a very long story about TypeScript programming',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
          includePartialMessages: true,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            // Handle partial messages from streaming
            if (
              message.event.type === 'content_block_delta' &&
              message.event.delta.type === 'text_delta'
            ) {
              accumulatedText += message.event.delta.text;

              // Abort when we have enough content to verify
              if (accumulatedText.length >= TARGET_CHARS) {
                controller.abort();
              }
            }
          } else if (isSDKAssistantMessage(message)) {
            // Handle complete assistant messages
            const textBlocks = message.message.content.filter(
              (block): block is TextBlock => block.type === 'text',
            );
            const chunkText = textBlocks.map((b) => b.text).join('');
            accumulatedText += chunkText;

            // Abort when we have enough content to verify
            if (accumulatedText.length >= TARGET_CHARS) {
              controller.abort();
            }
          }
        }

        // Should not reach here - query should be aborted
        expect(false).toBe(true);
      } catch (error) {
        expect(isAbortError(error)).toBe(true);
        // Should have accumulated at least TARGET_CHARS before abort
        expect(accumulatedText.length).toBeGreaterThanOrEqual(TARGET_CHARS);
      } finally {
        await q.close();
      }
    });

    it('should handle abort during query execution', async () => {
      const controller = new AbortController();

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
          debug: false,
        },
      });

      let receivedFirstMessage = false;

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message)) {
            if (!receivedFirstMessage) {
              // Abort immediately after receiving first assistant message
              receivedFirstMessage = true;
              controller.abort();
            }
          }
        }
      } catch (error) {
        expect(isAbortError(error)).toBe(true);
        expect(error instanceof AbortError).toBe(true);
        // Should have received at least one message before abort
        expect(receivedFirstMessage).toBe(true);
      } finally {
        await q.close();
      }
    });

    it('should handle abort immediately after query starts', async () => {
      const controller = new AbortController();

      const q = query({
        prompt: 'Write a very long essay',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
          debug: false,
        },
      });

      // Abort immediately after query initialization
      setTimeout(() => {
        controller.abort();
      }, 200);

      try {
        for await (const _message of q) {
          // May or may not receive messages before abort
        }
      } catch (error) {
        expect(isAbortError(error)).toBe(true);
        expect(error instanceof AbortError).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('Process Lifecycle Monitoring', () => {
    it('should handle normal process completion', async () => {
      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      let completedSuccessfully = false;
      let receivedAssistantMessage = false;

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message)) {
            receivedAssistantMessage = true;
          }
        }

        completedSuccessfully = true;
      } catch (error) {
        // Should not throw for normal completion
        expect(false).toBe(true);
      } finally {
        await q.close();
        expect(completedSuccessfully).toBe(true);
        expect(receivedAssistantMessage).toBe(true);
      }
    });

    it('should handle process cleanup after error', async () => {
      const q = query({
        prompt: 'Hello world',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message)) {
            const textBlocks = message.message.content.filter(
              (block): block is TextBlock => block.type === 'text',
            );
            const text = textBlocks
              .map((b) => b.text)
              .join('')
              .slice(0, 50);
            expect(text.length).toBeGreaterThan(0);
          }
        }
      } catch (error) {
        // Expected to potentially have errors
      } finally {
        // Should cleanup successfully even after error
        await q.close();
        expect(true).toBe(true); // Cleanup completed
      }
    });
  });

  describe('Input Stream Control', () => {
    it('should support endInput() method', async () => {
      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      let receivedResponse = false;
      let endInputCalled = false;

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message) && !endInputCalled) {
            receivedResponse = true;

            // End input after receiving first response
            q.endInput();
            endInputCalled = true;
          }
        }

        expect(receivedResponse).toBe(true);
        expect(endInputCalled).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('Closed stdin behavior (asyncGenerator prompt)', () => {
    it('should reject control requests after stdin closes', async () => {
      const resultWaiter = createResultWaiter(1);
      let promptDoneResolve: () => void = () => {};
      const promptDonePromise = new Promise<void>((resolve) => {
        promptDoneResolve = resolve;
      });

      async function* createPrompt(): AsyncIterable<SDKUserMessage> {
        yield {
          type: 'user',
          session_id: crypto.randomUUID(),
          message: {
            role: 'user',
            content: 'Say "OK".',
          },
          parent_tool_use_id: null,
        };

        await resultWaiter.waitForResult(0);
        promptDoneResolve();
      }

      const q = query({
        prompt: createPrompt(),
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      let firstResultReceived = false;

      try {
        for await (const message of q) {
          if (isSDKResultMessage(message)) {
            firstResultReceived = true;
            resultWaiter.notifyResult();
            break;
          }
        }

        expect(firstResultReceived).toBe(true);
        await promptDonePromise;
        q.endInput();

        await expect(q.setPermissionMode('default')).rejects.toThrow(
          'Input stream closed',
        );
      } finally {
        await q.close();
      }
    });

    it('should handle control responses when stdin closes before replies', async () => {
      const testFilePath = await helper.getPath('test.txt');
      await helper.createFile('test.txt', 'original content');

      // Bounded promise with explicit timer arming and clearing on settle.
      // `startTimer()` lets each phase begin counting only when its phase
      // actually starts, so slow predecessors don't burn its budget and
      // produce misleading timeout errors.
      const boundedPromise = (label: string, ms: number) => {
        let resolveFn: () => void = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pendingReject: (err: Error) => void = () => {};
        const promise = new Promise<void>((resolve, reject) => {
          resolveFn = () => {
            if (timer !== undefined) clearTimeout(timer);
            resolve();
          };
          pendingReject = reject;
        });
        const startTimer = () => {
          if (timer !== undefined) return;
          timer = setTimeout(() => {
            pendingReject(new Error(`${label} timeout after ${ms}ms`));
          }, ms);
        };
        return { promise, resolve: () => resolveFn(), startTimer };
      };

      const canUseToolCalled = boundedPromise(
        'canUseTool callback not called',
        15000,
      );
      const inputStreamDone = boundedPromise('inputStreamDone', 15000);
      const firstResult = boundedPromise('firstResult', 30000);
      const secondResult = boundedPromise('secondResult', 30000);

      // firstResult begins as soon as the query starts.
      firstResult.startTimer();

      let secondResultMessage: unknown;

      async function* createPrompt(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'Say "OK".',
          },
          parent_tool_use_id: null,
        };

        await firstResult.promise;

        // The second-turn phases only start now; arm their timers here so
        // a slow first turn does not burn their budgets.
        canUseToolCalled.startTimer();
        inputStreamDone.startTimer();
        secondResult.startTimer();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: `Write "updated" to ${testFilePath}. Stop if any exception occurs.`,
          },
          parent_tool_use_id: null,
        };
        await inputStreamDone.promise;
      }

      const q = query({
        prompt: createPrompt(),
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          permissionMode: 'default',
          coreTools: ['read_file', 'write_file'],
          canUseTool: async (toolName, input) => {
            // Only the write_file call against the target file constitutes
            // the permission-control path under test. Other tool calls
            // (e.g. read_file the model issues to look around first) are
            // allowed silently and must not advance the timing harness.
            const isTargetCall =
              toolName === 'write_file' &&
              (input as { file_path?: string }).file_path === testFilePath;
            if (!isTargetCall) {
              return { behavior: 'allow', updatedInput: input };
            }
            inputStreamDone.resolve();
            await new Promise((resolve) => setTimeout(resolve, 1000));
            canUseToolCalled.resolve();
            return { behavior: 'allow', updatedInput: input };
          },
          debug: false,
        },
      });

      try {
        const loop = async () => {
          let resultCount = 0;
          for await (const message of q) {
            if (isSDKResultMessage(message)) {
              resultCount += 1;
              if (resultCount === 1) {
                firstResult.resolve();
              }
              if (resultCount === 2) {
                secondResultMessage = message;
                secondResult.resolve();
                break;
              }
            }
          }
        };

        const loopPromise = loop();
        // Surface loop errors as a rejection-only race partner; loop
        // completion alone must NOT short-circuit the awaited milestones,
        // otherwise an iterator that ends before canUseTool is invoked
        // could mask the regression this test is meant to catch.
        const loopError = new Promise<never>((_, reject) => {
          loopPromise.catch(reject);
        });

        await Promise.race([
          (async () => {
            await firstResult.promise;
            await canUseToolCalled.promise;
            await secondResult.promise;
          })(),
          loopError,
        ]);

        expect(secondResultMessage).toBeDefined();
        const content = await helper.readFile('test.txt');
        expect(content).toBe('original content');
      } finally {
        await q.close();
      }
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle invalid executable path', async () => {
      try {
        const q = query({
          prompt: 'Hello world',
          options: {
            pathToQwenExecutable: '/nonexistent/path/to/cli',
            debug: false,
          },
        });

        // Should not reach here - query() should throw immediately
        for await (const _message of q) {
          // Should not reach here
        }

        // Should not reach here
        expect(false).toBe(true);
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toBeDefined();
        expect((error as Error).message).toContain(
          'Invalid pathToQwenExecutable',
        );
      }
    });

    it('should throw AbortError with correct properties', async () => {
      const controller = new AbortController();

      const q = query({
        prompt: 'Explain the concept of async programming',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
          debug: false,
        },
      });

      // Abort after allowing query to start
      setTimeout(() => controller.abort(), 1000);

      try {
        for await (const _message of q) {
          // May receive some messages before abort
        }
      } catch (error) {
        // Verify error type and helper functions
        expect(isAbortError(error)).toBe(true);
        expect(error instanceof AbortError).toBe(true);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
      } finally {
        await q.close();
      }
    });
  });

  describe('Debugging with stderr callback', () => {
    it('should capture stderr messages when debug is enabled', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      try {
        for await (const _message of q) {
          // Just consume all messages
        }
      } finally {
        await q.close();
        expect(stderrMessages.length).toBeGreaterThan(0);
      }
    });

    it('should not capture stderr when debug is disabled', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      try {
        for await (const _message of q) {
          // Consume all messages
        }
      } finally {
        await q.close();
        // Should have minimal or no stderr output when debug is false
        expect(stderrMessages.length).toBeLessThan(10);
      }
    });
  });

  describe('Abort with Cleanup', () => {
    it('should cleanup properly after abort', async () => {
      const controller = new AbortController();

      const q = query({
        prompt: 'Write a very long essay about programming',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
          debug: false,
        },
      });

      // Abort immediately
      setTimeout(() => controller.abort(), 100);

      try {
        for await (const _message of q) {
          // May receive some messages before abort
        }
      } catch (error) {
        if (error instanceof AbortError) {
          expect(true).toBe(true); // Expected abort error
        } else {
          throw error; // Unexpected error
        }
      } finally {
        await q.close();
        expect(true).toBe(true); // Cleanup completed after abort
      }
    });

    it('should handle multiple abort calls gracefully', async () => {
      const controller = new AbortController();

      const q = query({
        prompt: 'Count to 100',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
          debug: false,
        },
      });

      // Multiple abort calls
      setTimeout(() => controller.abort(), 100);
      setTimeout(() => controller.abort(), 200);
      setTimeout(() => controller.abort(), 300);

      try {
        for await (const _message of q) {
          // Should be interrupted
        }
      } catch (error) {
        expect(isAbortError(error)).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('Resource Management Edge Cases', () => {
    it('should handle close() called multiple times', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      // Start the query
      const iterator = q[Symbol.asyncIterator]();
      await iterator.next();

      // Close multiple times
      await q.close();
      await q.close();
      await q.close();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle abort after close', async () => {
      const controller = new AbortController();

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
          debug: false,
        },
      });

      // Start and close immediately
      const iterator = q[Symbol.asyncIterator]();
      await iterator.next();
      await q.close();

      // Abort after close
      controller.abort();

      // Should not throw
      expect(true).toBe(true);
    });
  });
});
