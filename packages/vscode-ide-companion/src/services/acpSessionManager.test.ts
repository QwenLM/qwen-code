/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpSessionManager } from './acpSessionManager.js';
import type { ChildProcess } from 'child_process';
import type { PendingRequest } from '../types/connectionTypes.js';
import { AGENT_METHODS } from '../constants/acpSchema.js';

describe('AcpSessionManager', () => {
  let sessionManager: AcpSessionManager;
  let mockChild: ChildProcess;
  let pendingRequests: Map<number, PendingRequest<unknown>>;
  let nextRequestId: { value: number };
  let writtenMessages: string[];

  beforeEach(() => {
    sessionManager = new AcpSessionManager();
    writtenMessages = [];

    mockChild = {
      stdin: {
        write: vi.fn((msg: string) => {
          writtenMessages.push(msg);
          // Simulate async response
          const parsed = JSON.parse(msg.trim());
          const id = parsed.id;
          setTimeout(() => {
            const pending = pendingRequests.get(id);
            if (pending) {
              pending.resolve({ modeId: 'default', modelId: 'test-model' });
              pendingRequests.delete(id);
            }
          }, 10);
        }),
      },
    } as unknown as ChildProcess;

    pendingRequests = new Map();
    nextRequestId = { value: 0 };
  });

  describe('setModel', () => {
    it('sends session/set_model request with correct parameters', async () => {
      // First initialize the session
      // @ts-expect-error - accessing private property for testing
      sessionManager.sessionId = 'test-session-id';

      const responsePromise = sessionManager.setModel(
        'qwen3-coder-plus',
        mockChild,
        pendingRequests,
        nextRequestId,
      );

      // Wait for the response
      const response = await responsePromise;

      // Verify the message was sent
      expect(writtenMessages.length).toBe(1);
      const sentMessage = JSON.parse(writtenMessages[0].trim());

      expect(sentMessage.method).toBe(AGENT_METHODS.session_set_model);
      expect(sentMessage.params).toEqual({
        sessionId: 'test-session-id',
        modelId: 'qwen3-coder-plus',
      });
      expect(response).toEqual({ modeId: 'default', modelId: 'test-model' });
    });

    it('throws error when no active session', async () => {
      await expect(
        sessionManager.setModel(
          'qwen3-coder-plus',
          mockChild,
          pendingRequests,
          nextRequestId,
        ),
      ).rejects.toThrow('No active ACP session');
    });

    it('increments request ID for each call', async () => {
      // @ts-expect-error - accessing private property for testing
      sessionManager.sessionId = 'test-session-id';

      await sessionManager.setModel(
        'model-1',
        mockChild,
        pendingRequests,
        nextRequestId,
      );

      await sessionManager.setModel(
        'model-2',
        mockChild,
        pendingRequests,
        nextRequestId,
      );

      const firstMessage = JSON.parse(writtenMessages[0].trim());
      const secondMessage = JSON.parse(writtenMessages[1].trim());

      expect(firstMessage.id).toBe(0);
      expect(secondMessage.id).toBe(1);
    });
  });

  describe('setMode', () => {
    it('sends session/set_mode request with correct parameters', async () => {
      // @ts-expect-error - accessing private property for testing
      sessionManager.sessionId = 'test-session-id';

      const responsePromise = sessionManager.setMode(
        'auto-edit',
        mockChild,
        pendingRequests,
        nextRequestId,
      );

      const response = await responsePromise;

      expect(writtenMessages.length).toBe(1);
      const sentMessage = JSON.parse(writtenMessages[0].trim());

      expect(sentMessage.method).toBe(AGENT_METHODS.session_set_mode);
      expect(sentMessage.params).toEqual({
        sessionId: 'test-session-id',
        modeId: 'auto-edit',
      });
      expect(response).toBeDefined();
    });

    it('throws error when no active session', async () => {
      await expect(
        sessionManager.setMode(
          'default',
          mockChild,
          pendingRequests,
          nextRequestId,
        ),
      ).rejects.toThrow('No active ACP session');
    });
  });
});
