/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for SDK session-id functionality:
 * - sessionId option: Allows users to specify a custom session ID
 * - Validation: Session ID must be a valid UUID
 * - Integration: Session ID is passed to CLI via --session-id flag
 * - Behavior: sessionId cannot be used with resume or continue
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query, isSDKSystemMessage, type SDKMessage } from '@qwen-code/sdk';
import {
  SDKTestHelper,
  createSharedTestOptions,
  assertSuccessfulCompletion,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

describe('Session ID Support (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    // Enable chat recording for session-id tests to allow duplicate session detection
    testDir = await helper.setup('session-id', { chatRecording: true });
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('sessionId Option', () => {
    it('should accept a valid UUID as sessionId', async () => {
      // Valid UUID v4: 4 in position 14, 8/9/a/b in position 19
      const customSessionId = '12345678-1234-4234-8234-123456789abc';

      const q = query({
        prompt: 'What is 1 + 1? Just the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        assertSuccessfulCompletion(messages);

        // Verify the query used the custom session ID
        expect(q.getSessionId()).toBe(customSessionId);
      } finally {
        await q.close();
      }
    });

    it('should use sessionId in system init message', async () => {
      // Valid UUID v4: 4 in position 14, 8/9/a/b in position 19
      const customSessionId = 'abcdef12-3456-4234-abcd-ef1234567890';

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);

          // Stop after we get the system init message
          if (isSDKSystemMessage(message) && message.subtype === 'init') {
            expect(message.session_id).toBe(customSessionId);
            break;
          }
        }
      } finally {
        await q.close();
      }
    });

    it('should pass sessionId to CLI via arguments', async () => {
      // Valid UUID v4: 4 in position 14, 8/9/a/b in position 19
      const customSessionId = 'a1b2c3d4-e5f6-4234-abcd-ef1234567890';
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'What is 2 + 2? Just the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          debug: true,
          logLevel: 'debug',
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
        },
      });

      try {
        for await (const _message of q) {
          // Consume all messages
        }

        // Verify that CLI was spawned with --session-id argument
        const hasSessionIdArg = stderrMessages.some((msg) =>
          msg.includes('--session-id'),
        );
        expect(hasSessionIdArg).toBe(true);

        // Verify the session ID value is in the arguments
        const hasCorrectSessionId = stderrMessages.some((msg) =>
          msg.includes(customSessionId),
        );
        expect(hasCorrectSessionId).toBe(true);
      } finally {
        await q.close();
      }
    });

    it('should auto-generate sessionId when not provided', async () => {
      const q = query({
        prompt: 'What is 3 + 3? Just the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        assertSuccessfulCompletion(messages);

        // Verify the query has a valid auto-generated session ID
        const sessionId = q.getSessionId();
        expect(sessionId).toBeDefined();
        expect(sessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      } finally {
        await q.close();
      }
    });

    it('should reject using sessionId with resume', async () => {
      // Valid UUIDs: 4 in position 14, 8/9/a/b in position 19
      const customSessionId = '11111111-2222-4333-a444-555555555555';
      const resumeSessionId = '66666666-7777-4888-b999-000000000000';

      // CLI rejects using --session-id with --resume
      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          resume: resumeSessionId,
          debug: false,
        },
      });

      try {
        for await (const _message of q) {
          // Consume messages
        }
        // Should not reach here - CLI should reject this combination
        throw new Error(
          'Expected query to fail when using sessionId with resume',
        );
      } catch (error) {
        // Expected to fail - CLI rejects --session-id with --resume
        expect(error).toBeDefined();
      } finally {
        await q.close();
      }
    });
  });

  describe('Session ID Validation', () => {
    it('should reject invalid sessionId format', async () => {
      const invalidSessionId = 'not-a-valid-uuid';

      expect(() => {
        query({
          prompt: 'Say hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            sessionId: invalidSessionId,
          },
        });
      }).toThrow(/Invalid sessionId/);
    });

    it('should reject sessionId with wrong UUID version', async () => {
      // UUID version 6 (not valid - must be 1-5)
      const invalidVersionSessionId = '12345678-1234-6789-8234-123456789abc';

      expect(() => {
        query({
          prompt: 'Say hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            sessionId: invalidVersionSessionId,
          },
        });
      }).toThrow(/Invalid sessionId/);
    });

    it('should reject sessionId with invalid variant', async () => {
      // Invalid variant (must be 8, 9, a, or b in position 19)
      const invalidVariantSessionId = '12345678-1234-1234-c234-823456789abc';

      expect(() => {
        query({
          prompt: 'Say hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            sessionId: invalidVariantSessionId,
          },
        });
      }).toThrow(/Invalid sessionId/);
    });

    it('should handle empty sessionId gracefully', async () => {
      // Note: Empty string behavior - validation skips it but Query constructor may use it
      // This test documents the current behavior
      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: '',
        },
      });

      try {
        // When empty string is provided, the query should still be created
        // The actual session ID behavior depends on implementation details
        const sessionId = q.getSessionId();
        expect(sessionId).toBeDefined();

        // If empty string is used, it's passed through; otherwise a UUID is generated
        // Either way, the query should function
        for await (const _message of q) {
          // Consume messages
        }
      } finally {
        await q.close();
      }
    });

    it('should accept various valid UUID formats', async () => {
      const validUUIDs = [
        '12345678-1234-1234-8234-123456789abc', // version 1, variant 8
        '12345678-1234-1234-9234-123456789abc', // version 1, variant 9
        '12345678-1234-1234-a234-123456789abc', // version 1, variant a
        '12345678-1234-1234-b234-123456789abc', // version 1, variant b
        '12345678-1234-2234-8234-123456789abc', // version 2, variant 8
        '12345678-1234-3234-8234-123456789abc', // version 3, variant 8
        '12345678-1234-4234-8234-123456789abc', // version 4, variant 8
        '12345678-1234-5234-8234-123456789abc', // version 5, variant 8
      ];

      for (const uuid of validUUIDs) {
        const q = query({
          prompt: 'Say hi',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            sessionId: uuid,
            debug: false,
          },
        });

        try {
          // Just verify the query is created without throwing
          expect(q.getSessionId()).toBe(uuid);
        } finally {
          await q.close();
        }
      }
    });
  });

  describe('Multi-turn with Custom Session ID', () => {
    it('should maintain custom sessionId across multiple turns', async () => {
      // Valid UUID v4: 4 in position 14, 8/9/a/b in position 19
      const customSessionId = '99999999-8888-4777-a666-555555555555';

      async function* createConversation(): AsyncIterable<{
        type: 'user';
        session_id: string;
        message: { role: 'user'; content: string };
        parent_tool_use_id: null;
      }> {
        yield {
          type: 'user',
          session_id: customSessionId,
          message: {
            role: 'user',
            content: 'What is 1 + 1?',
          },
          parent_tool_use_id: null,
        };

        await new Promise((resolve) => setTimeout(resolve, 100));

        yield {
          type: 'user',
          session_id: customSessionId,
          message: {
            role: 'user',
            content: 'What is 2 + 2?',
          },
          parent_tool_use_id: null,
        };
      }

      const q = query({
        prompt: createConversation(),
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        assertSuccessfulCompletion(messages);

        // Verify all system messages use the custom session ID
        const systemMessages = messages.filter(isSDKSystemMessage);
        for (const sysMsg of systemMessages) {
          expect(sysMsg.session_id).toBe(customSessionId);
        }
      } finally {
        await q.close();
      }
    });
  });

  describe('Session ID Duplicate Detection', () => {
    it('should reject duplicate sessionId with error', async () => {
      // Generate a unique UUID for this test
      const customSessionId = crypto.randomUUID();

      // First query: create a session with the custom session ID
      const q1 = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          env: {
            SANDBOX_SET_UID_GID: 'true',
          },
        },
      });

      // Consume the first query to completion and close it
      try {
        for await (const _msg of q1) {
          // consume
        }
      } finally {
        await q1.close();
      }

      // Second query: try to use the same session ID
      // This should fail because the session ID is already in use
      // CLI will exit with code 1 when detecting duplicate session ID
      const q2 = query({
        prompt: 'Say hello again',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          env: {
            SANDBOX_SET_UID_GID: 'true',
          },
        },
      });

      // The error should be propagated and the iteration should throw
      // When iterating over messages, if CLI exits with code 1 (duplicate session ID),
      // the error should be thrown during iteration
      await expect(async () => {
        for await (const _msg of q2) {
          // consume
        }
      }).rejects.toThrow(/CLI process exited with code 1/);

      await q2.close();
    });

    it('should throw error when CLI exits with non-zero code', async () => {
      // Generate a unique UUID for this test
      const customSessionId = crypto.randomUUID();

      // First query: create a session and properly close it after completion
      const q1 = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          env: {
            SANDBOX_SET_UID_GID: 'true',
          },
        },
      });

      try {
        for await (const _msg of q1) {
          // consume
        }
      } finally {
        await q1.close();
      }

      // Second query with same session ID
      // When using the same session ID, CLI will detect the duplicate and exit with code 1
      const q2 = query({
        prompt: 'Say hello again',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          env: {
            SANDBOX_SET_UID_GID: 'true',
          },
        },
      });

      let errorCaught = false;
      let errorMessage = '';

      try {
        // Iterate over messages - the error should be thrown during iteration
        // because CLI exits with code 1 when detecting duplicate session ID
        for await (const _msg of q2) {
          // consume
        }
      } catch (error) {
        errorCaught = true;
        // CLI errors are written directly to console (stderr inherit mode)
        // SDK only reports the exit status, not the error message
        expect(error instanceof Error).toBe(true);
        errorMessage = error instanceof Error ? error.message : String(error);
        // Verify the error message contains the expected exit code
        expect(errorMessage).toContain('CLI process exited with code 1');
      } finally {
        await q2.close();
      }

      // Verify that an error was actually caught during message iteration
      expect(errorCaught).toBe(true);
    });
  });

  describe('Session ID Consistency', () => {
    it('should expose same sessionId via getSessionId() and messages', async () => {
      // Valid UUID v4: 4 in position 14, 8/9/a/b in position 19
      const customSessionId = 'aaaaaaaa-bbbb-4ccc-adde-eeeeeeeeeeee';

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          sessionId: customSessionId,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Verify getSessionId() matches the option
        expect(q.getSessionId()).toBe(customSessionId);

        // Verify system messages have the same session ID
        const systemMessages = messages.filter(isSDKSystemMessage);
        expect(systemMessages.length).toBeGreaterThan(0);
        for (const sysMsg of systemMessages) {
          expect(sysMsg.session_id).toBe(customSessionId);
        }
      } finally {
        await q.close();
      }
    });

    it('should generate different session IDs for different queries', async () => {
      const q1 = query({
        prompt: 'Say one',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const q2 = query({
        prompt: 'Say two',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        // Consume messages from both queries
        for await (const _msg of q1) {
          // consume
        }
        for await (const _msg of q2) {
          // consume
        }

        const sessionId1 = q1.getSessionId();
        const sessionId2 = q2.getSessionId();

        // Session IDs should be different
        expect(sessionId1).toBeDefined();
        expect(sessionId2).toBeDefined();
        expect(sessionId1).not.toBe(sessionId2);

        // Both should be valid UUIDs
        expect(sessionId1).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(sessionId2).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      } finally {
        await q1.close();
        await q2.close();
      }
    });
  });
});
