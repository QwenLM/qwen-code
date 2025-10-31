/**
 * E2E tests based on abort-and-lifecycle.ts example
 * Tests AbortController integration and process lifecycle management
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { describe, it, expect } from 'vitest';
import {
  query,
  AbortError,
  isAbortError,
  isCLIAssistantMessage,
  type TextBlock,
  type ContentBlock,
} from '../../src/index.js';

// Test configuration
const TEST_CLI_PATH =
  '/Users/mingholy/Work/Projects/qwen-code/packages/cli/index.ts';
const TEST_TIMEOUT = 30000;

// Shared test options with permissionMode to allow all tools
const SHARED_TEST_OPTIONS = {
  pathToQwenExecutable: TEST_CLI_PATH,
  permissionMode: 'yolo' as const,
};

describe('AbortController and Process Lifecycle (E2E)', () => {
  describe('Basic AbortController Usage', () => {
    /* TODO: Currently query does not throw AbortError when aborted */
    it(
      'should support AbortController cancellation',
      async () => {
        const controller = new AbortController();

        // Abort after 2 seconds
        setTimeout(() => {
          controller.abort();
        }, 2000);

        const q = query({
          prompt: 'Write a very long story about TypeScript programming',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
            debug: false,
          },
        });

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
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
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle immediate abort',
      async () => {
        const controller = new AbortController();

        const q = query({
          prompt: 'Write a very long essay',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
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
          expect(error instanceof AbortError).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Process Lifecycle Monitoring', () => {
    it(
      'should handle normal process completion',
      async () => {
        const q = query({
          prompt: 'Why do we choose to go to the moon?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let completedSuccessfully = false;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
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
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle process cleanup after error',
      async () => {
        const q = query({
          prompt: 'Hello world',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
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
      },
      TEST_TIMEOUT,
    );
  });

  describe('Input Stream Control', () => {
    it(
      'should support endInput() method',
      async () => {
        const q = query({
          prompt: 'What is 2 + 2?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let receivedResponse = false;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              const textBlocks = message.message.content.filter(
                (block: ContentBlock): block is TextBlock =>
                  block.type === 'text',
              );
              const text = textBlocks
                .map((b: TextBlock) => b.text)
                .join('')
                .slice(0, 100);

              expect(text.length).toBeGreaterThan(0);
              receivedResponse = true;

              // End input after receiving first response
              q.endInput();
              break;
            }
          }

          expect(receivedResponse).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Error Handling and Recovery', () => {
    it(
      'should handle invalid executable path',
      async () => {
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
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle AbortError correctly',
      async () => {
        const controller = new AbortController();

        const q = query({
          prompt: 'Write a long story',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
            debug: false,
          },
        });

        // Abort after short delay
        setTimeout(() => controller.abort(), 500);

        try {
          for await (const _message of q) {
            // May receive some messages
          }
        } catch (error) {
          expect(isAbortError(error)).toBe(true);
          expect(error instanceof AbortError).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Debugging with stderr callback', () => {
    it(
      'should capture stderr messages when debug is enabled',
      async () => {
        const stderrMessages: string[] = [];

        const q = query({
          prompt: 'Why do we choose to go to the moon?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: true,
            stderr: (message: string) => {
              stderrMessages.push(message);
            },
          },
        });

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
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
      },
      TEST_TIMEOUT,
    );

    it(
      'should not capture stderr when debug is disabled',
      async () => {
        const stderrMessages: string[] = [];

        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
            stderr: (message: string) => {
              stderrMessages.push(message);
            },
          },
        });

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              break;
            }
          }
        } finally {
          await q.close();
          // Should have minimal or no stderr output when debug is false
          expect(stderrMessages.length).toBeLessThan(10);
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Abort with Cleanup', () => {
    it(
      'should cleanup properly after abort',
      async () => {
        const controller = new AbortController();

        const q = query({
          prompt: 'Write a very long essay about programming',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
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
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle multiple abort calls gracefully',
      async () => {
        const controller = new AbortController();

        const q = query({
          prompt: 'Count to 100',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
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
      },
      TEST_TIMEOUT,
    );
  });

  describe('Resource Management Edge Cases', () => {
    it(
      'should handle close() called multiple times',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
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
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle abort after close',
      async () => {
        const controller = new AbortController();

        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
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
      },
      TEST_TIMEOUT,
    );
  });
});
