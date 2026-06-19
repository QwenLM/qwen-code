import { describe, expect, it } from 'bun:test';
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import type { Message } from '@craft-agent/core/types';
import type { Workspace } from '@craft-agent/shared/config';
import {
  createManagedSession,
  SessionManager,
} from './SessionManager.ts';

type TestManagedSession = ReturnType<typeof createManagedSession>;

describe('permission mode persistence', () => {
  it('does not persist sessions when only the global permission mode changes', async () => {
    const workspace: Workspace = {
      id: 'workspace-mode',
      name: 'Mode Workspace',
      slug: 'mode-workspace',
      rootPath: '/tmp/mode-workspace',
      createdAt: 1,
    };
    const manager = new SessionManager();
    const managed = createManagedSession(
      {
        id: 'session-mode',
        createdAt: 1,
        lastUsedAt: 2,
        lastMessageAt: 2,
        permissionMode: 'ask',
      },
      workspace,
      {
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'hello',
            timestamp: 2,
          } as Message,
        ],
        messagesLoaded: true,
      },
    );

    const internals = manager as unknown as {
      sessions: Map<string, TestManagedSession>;
    };
    internals.sessions.set(managed.id, managed);

    const queue = sessionPersistenceQueue as unknown as {
      enqueue: (session: unknown) => void;
    };
    const originalEnqueue = queue.enqueue.bind(sessionPersistenceQueue);
    let enqueueCalls = 0;
    queue.enqueue = (session: unknown) => {
      enqueueCalls += 1;
      originalEnqueue(session);
    };

    try {
      await manager.applyGlobalPermissionMode('allow-all');
    } finally {
      queue.enqueue = originalEnqueue;
    }

    expect(enqueueCalls).toBe(0);
    expect(managed.permissionMode).toBe('allow-all');
  });
});
