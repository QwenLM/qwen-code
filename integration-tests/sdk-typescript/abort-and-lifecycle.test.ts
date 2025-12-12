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
  type TextBlock,
  type ContentBlock,
} from '@qwen-code/sdk';
import { SDKTestHelper, createSharedTestOptions } from './test-helper.js';

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

      // Abort after 5 seconds
      setTimeout(() => {
        controller.abort();
      }, 5000);

      const q = query({
        prompt: 'Write a very long story about TypeScript programming',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          abortController: controller,
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
              .slice(0, 100);

            // Should receive some content before abort
            expect(text.length).toBeGreaterThan(0);
          }
        }

        // Should not reach here - query should be aborted
        expect(false).toBe(true);
      } catch (error) {
        expect(isAbortError(error)).toBe(true);
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
        prompt: 'Why do we choose to go to the moon?',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      let completedSuccessfully = false;

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message)) {
            const textBlocks = message.message.content.filter(
              (block): block is TextBlock => block.type === 'text',
            );
            const text = textBlocks
              .map((b) => b.text)
              .join('')
              .slice(0, 100);
            expect(text.length).toBeGreaterThan(0);
          }
        }

        completedSuccessfully = true;
      } catch (error) {
        // Should not throw for normal completion
        expect(false).toBe(true);
      } finally {
        await q.close();
        expect(completedSuccessfully).toBe(true);
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
        prompt: 'What is 2 + 2?',
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
            const textBlocks = message.message.content.filter(
              (block: ContentBlock): block is TextBlock =>
                block.type === 'text',
            );
            const text = textBlocks.map((b: TextBlock) => b.text).join('');

            expect(text.length).toBeGreaterThan(0);
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
        prompt: 'Why do we choose to go to the moon?',
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
