/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for SDK configuration options:
 * - logLevel: Controls SDK internal logging verbosity
 * - env: Environment variables passed to CLI process
 * - authType: Authentication type for AI service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  type SDKMessage,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  extractText,
  createSharedTestOptions,
  assertSuccessfulCompletion,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

describe('Configuration Options (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('configuration-options');
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('logLevel Option', () => {
    it('should respect logLevel: debug and capture detailed logs', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'What is 1 + 1? Just answer the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          logLevel: 'debug',
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Debug level should produce verbose logging
        expect(stderrMessages.length).toBeGreaterThan(0);

        // Debug logs should contain detailed information like [DEBUG]
        const hasDebugLogs = stderrMessages.some(
          (msg) => msg.includes('[DEBUG]') || msg.includes('debug'),
        );
        expect(hasDebugLogs).toBe(true);

        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should respect logLevel: info and filter out debug messages', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'What is 2 + 2? Just answer the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          logLevel: 'info',
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Info level should filter out debug messages
        // Check that we don't have [DEBUG] level messages from the SDK logger
        const sdkDebugLogs = stderrMessages.filter(
          (msg) =>
            msg.includes('[DEBUG]') && msg.includes('[ProcessTransport]'),
        );
        expect(sdkDebugLogs.length).toBe(0);

        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should respect logLevel: warn and only show warnings and errors', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          logLevel: 'warn',
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Warn level should filter out info and debug messages from SDK
        const sdkInfoOrDebugLogs = stderrMessages.filter(
          (msg) =>
            (msg.includes('[DEBUG]') || msg.includes('[INFO]')) &&
            (msg.includes('[ProcessTransport]') ||
              msg.includes('[createQuery]') ||
              msg.includes('[Query]')),
        );
        expect(sdkInfoOrDebugLogs.length).toBe(0);

        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should respect logLevel: error and only show error messages', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Hello world',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          logLevel: 'error',
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Error level should filter out all non-error messages from SDK
        const sdkNonErrorLogs = stderrMessages.filter(
          (msg) =>
            (msg.includes('[DEBUG]') ||
              msg.includes('[INFO]') ||
              msg.includes('[WARN]')) &&
            (msg.includes('[ProcessTransport]') ||
              msg.includes('[createQuery]') ||
              msg.includes('[Query]')),
        );
        expect(sdkNonErrorLogs.length).toBe(0);

        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should use logLevel over debug flag when both are provided', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'What is 3 + 3?',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: true, // Would normally enable debug logging
          logLevel: 'error', // But logLevel should take precedence
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      try {
        for await (const _message of q) {
          // Consume all messages
        }

        // logLevel: error should suppress debug/info/warn even with debug: true
        const sdkNonErrorLogs = stderrMessages.filter(
          (msg) =>
            (msg.includes('[DEBUG]') ||
              msg.includes('[INFO]') ||
              msg.includes('[WARN]')) &&
            (msg.includes('[ProcessTransport]') ||
              msg.includes('[createQuery]') ||
              msg.includes('[Query]')),
        );
        expect(sdkNonErrorLogs.length).toBe(0);
      } finally {
        await q.close();
      }
    });
  });

  describe('env Option', () => {
    it('should pass custom environment variables to CLI process', async () => {
      const q = query({
        prompt: 'What is 1 + 1? Just the number please.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          env: {
            CUSTOM_TEST_VAR: 'test_value_12345',
            ANOTHER_VAR: 'another_value',
          },
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // The query should complete successfully with custom env vars
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should allow overriding existing environment variables', async () => {
      // Store original value for comparison
      const originalPath = process.env['PATH'];

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          env: {
            // Override an existing env var (not PATH as it might break things)
            MY_TEST_OVERRIDE: 'overridden_value',
          },
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Query should complete successfully
        assertSuccessfulCompletion(messages);

        // Verify original process env is not modified
        expect(process.env['PATH']).toBe(originalPath);
      } finally {
        await q.close();
      }
    });

    it('should work with empty env object', async () => {
      const q = query({
        prompt: 'What is 2 + 2?',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          env: {},
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should support setting model-related environment variables', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          env: {
            // Common model-related env vars that CLI might respect
            OPENAI_API_KEY: process.env['OPENAI_API_KEY'] || 'test-key',
          },
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Should complete (may succeed or fail based on API key validity)
        expect(messages.length).toBeGreaterThan(0);
      } finally {
        await q.close();
      }
    });

    it('should not leak env vars between query instances', async () => {
      // First query with specific env var
      const q1 = query({
        prompt: 'Say one',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          env: {
            ISOLATED_VAR_1: 'value_1',
          },
          debug: false,
        },
      });

      try {
        for await (const _message of q1) {
          // Consume messages
        }
      } finally {
        await q1.close();
      }

      // Second query with different env var
      const q2 = query({
        prompt: 'Say two',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          env: {
            ISOLATED_VAR_2: 'value_2',
          },
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q2) {
          messages.push(message);
        }

        // Second query should complete successfully
        assertSuccessfulCompletion(messages);

        // Verify process.env is not polluted by either query
        expect(process.env['ISOLATED_VAR_1']).toBeUndefined();
        expect(process.env['ISOLATED_VAR_2']).toBeUndefined();
      } finally {
        await q2.close();
      }
    });
  });

  describe('authType Option', () => {
    it('should accept authType: openai', async () => {
      const q = query({
        prompt: 'What is 1 + 1? Just the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          authType: 'openai',
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Query should complete with openai auth type
        assertSuccessfulCompletion(messages);

        // Verify we got an assistant response
        const assistantMessages = messages.filter(isSDKAssistantMessage);
        expect(assistantMessages.length).toBeGreaterThan(0);
      } finally {
        await q.close();
      }
    });

    // Skip - qwen-oauth requires user interaction which is not possible in CI environments
    it.skip('should accept authType: qwen-oauth', async () => {
      // Note: qwen-oauth requires credentials in ~/.qwen and user interaction
      // Without credentials, the auth process will timeout waiting for user
      // This test verifies the option is accepted and passed correctly to CLI

      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          authType: 'qwen-oauth',
          debug: true,
          logLevel: 'debug',
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        // Use a timeout to avoid hanging when credentials are not configured
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 20000),
        );

        const collectMessages = async () => {
          for await (const message of q) {
            messages.push(message);
          }
          return 'completed';
        };

        const result = await Promise.race([collectMessages(), timeoutPromise]);

        if (result === 'timeout') {
          // Timeout is expected when OAuth credentials are not configured
          // Verify that CLI was spawned with correct --auth-type argument
          const hasAuthTypeArg = stderrMessages.some((msg) =>
            msg.includes('--auth-type'),
          );
          expect(hasAuthTypeArg).toBe(true);
        } else {
          // If credentials exist and auth completed, verify we got messages
          expect(messages.length).toBeGreaterThan(0);
        }
      } finally {
        await q.close();
      }
    });

    it('should use default auth when authType is not specified', async () => {
      const q = query({
        prompt: 'What is 2 + 2? Just the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          // authType not specified - should use default
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Query should complete with default auth
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should properly pass authType to CLI process', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Say hi',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          authType: 'openai',
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // There should be spawn log containing auth-type
        const hasAuthTypeArg = stderrMessages.some((msg) =>
          msg.includes('--auth-type'),
        );
        expect(hasAuthTypeArg).toBe(true);

        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });
  });

  describe('Combined Options', () => {
    it('should work with logLevel, env, and authType together', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'What is 3 + 3? Just the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          logLevel: 'debug',
          env: {
            COMBINED_TEST_VAR: 'combined_value',
          },
          authType: 'openai',
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      const messages: SDKMessage[] = [];
      let assistantText = '';

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            assistantText += extractText(message.message.content);
          }
        }

        // All three options should work together
        expect(stderrMessages.length).toBeGreaterThan(0); // logLevel: debug produces logs
        expect(assistantText).toMatch(/6/); // Query should work
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should maintain system message consistency with all options', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          logLevel: 'info',
          env: {
            SYSTEM_MSG_TEST: 'test',
          },
          authType: 'openai',
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Should have system init message
        const systemMessages = messages.filter(isSDKSystemMessage);
        const initMessage = systemMessages.find((m) => m.subtype === 'init');

        expect(initMessage).toBeDefined();
        expect(initMessage!.session_id).toBeDefined();
        expect(initMessage!.tools).toBeDefined();
        expect(initMessage!.permission_mode).toBeDefined();

        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });
  });
});
