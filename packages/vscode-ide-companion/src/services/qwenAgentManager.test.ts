/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractSessionListItems,
  QwenAgentManager,
} from './qwenAgentManager.js';
import type { ModelInfo } from '@agentclientprotocol/sdk';

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

describe('extractSessionListItems', () => {
  it('returns sessions array from the "sessions" field', () => {
    const items = extractSessionListItems({
      sessions: [{ sessionId: 'session-1' }],
    });
    expect(items).toEqual([{ sessionId: 'session-1' }]);
  });

  it('returns items array from the legacy "items" field', () => {
    const items = extractSessionListItems({
      items: [{ sessionId: 'session-2' }],
    });
    expect(items).toEqual([{ sessionId: 'session-2' }]);
  });

  it('prefers "sessions" over "items" when both are present', () => {
    const items = extractSessionListItems({
      sessions: [{ sessionId: 'from-sessions' }],
      items: [{ sessionId: 'from-items' }],
    });
    expect(items).toEqual([{ sessionId: 'from-sessions' }]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(extractSessionListItems(null)).toEqual([]);
    expect(extractSessionListItems(undefined)).toEqual([]);
  });

  it('returns empty array for non-object input', () => {
    expect(extractSessionListItems('string')).toEqual([]);
    expect(extractSessionListItems(42)).toEqual([]);
  });

  it('returns empty array when neither field is an array', () => {
    expect(extractSessionListItems({ sessions: 'not-array' })).toEqual([]);
    expect(extractSessionListItems({ items: 123 })).toEqual([]);
    expect(extractSessionListItems({})).toEqual([]);
  });
});

describe('QwenAgentManager.getSessionListPaged', () => {
  it('passes opaque session-list cursors through verbatim', async () => {
    // Regression: the daemon may return a composite "<mtimeMs>:<sessionId>"
    // cursor. Number()-parsing it yields NaN, which the old code treated as
    // "no next page" and silently stopped pagination after page one.
    const manager = new QwenAgentManager();
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Stored session',
        },
      ],
      nextCursor: '1755000000000.5:550e8400-e29b-41d4-a716-446655440000',
    });
    (manager as unknown as { connection: unknown }).connection = {
      listSessions,
    };

    const page = await manager.getSessionListPaged({
      cursor: '1755000000000:550e8400-e29b-41d4-a716-446655440001',
      size: 5,
    });

    expect(listSessions).toHaveBeenCalledWith({
      size: 5,
      cursor: '1755000000000:550e8400-e29b-41d4-a716-446655440001',
    });
    expect(page.nextCursor).toBe(
      '1755000000000.5:550e8400-e29b-41d4-a716-446655440000',
    );
    expect(page.hasMore).toBe(true);
  });

  it('passes a legacy bare-mtime cursor string through verbatim', async () => {
    const manager = new QwenAgentManager();
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [],
      nextCursor: '1755000000000',
    });
    (manager as unknown as { connection: unknown }).connection = {
      listSessions,
    };

    const page = await manager.getSessionListPaged({ size: 5 });

    expect(page.nextCursor).toBe('1755000000000');
    expect(page.hasMore).toBe(true);
  });

  it('coerces a numeric JSON nextCursor from the daemon to its string form', async () => {
    // Some ACP agents emit nextCursor as a JSON number; the wire form this
    // client forwards must stay a string (acpConnection stringifies on send).
    const manager = new QwenAgentManager();
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [],
      nextCursor: 1755000000000,
    });
    (manager as unknown as { connection: unknown }).connection = {
      listSessions,
    };

    const page = await manager.getSessionListPaged({ size: 5 });

    expect(page.nextCursor).toBe('1755000000000');
    expect(page.hasMore).toBe(true);
  });

  it('treats an empty-string nextCursor as the end of pagination', async () => {
    const manager = new QwenAgentManager();
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Stored session',
        },
      ],
      nextCursor: '',
    });
    (manager as unknown as { connection: unknown }).connection = {
      listSessions,
    };

    const page = await manager.getSessionListPaged({ size: 5 });

    expect(page.nextCursor).toBeUndefined();
    expect(page.hasMore).toBe(false);
  });

  it('fails closed when a composite cursor reaches the filesystem fallback', async () => {
    // Regression: a composite "<mtimeMs>:<sessionId>" cursor parses to NaN;
    // the fallback must return an empty page, not the unfiltered list
    // (which would re-serve page one and duplicate rows in the webview).
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const stored = [
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        projectHash: 'p',
        startTime: '2026-08-17T00:00:00.000Z',
        lastUpdated: '2026-08-17T00:00:00.000Z',
        messages: [],
      },
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
        projectHash: 'p',
        startTime: '2026-08-17T00:01:00.000Z',
        lastUpdated: '2026-08-17T00:01:00.000Z',
        messages: [],
      },
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const page = await manager.getSessionListPaged({
      cursor: '1755000000000:550e8400-e29b-41d4-a716-446655440000',
      size: 1,
    });

    expect(page.sessions).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('filters by a legacy numeric cursor in the filesystem fallback', async () => {
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const stored = [
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        projectHash: 'p',
        startTime: '2026-08-17T00:00:00.000Z',
        lastUpdated: '2026-08-17T00:00:00.000Z',
        messages: [],
      },
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
        projectHash: 'p',
        startTime: '2026-08-17T00:01:00.000Z',
        lastUpdated: '2026-08-17T00:01:00.000Z',
        messages: [],
      },
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const boundary = new Date('2026-08-17T00:00:30.000Z').getTime();
    const page = await manager.getSessionListPaged({
      cursor: String(boundary),
      size: 10,
    });

    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440000',
    ]);
    expect(page.hasMore).toBe(false);
  });
});

describe('QwenAgentManager.setModelFromUi', () => {
  it('emits the selected model metadata from the available models list', async () => {
    const manager = new QwenAgentManager();
    const onModelChanged = vi.fn();
    manager.onModelChanged(onModelChanged);

    const selectedModel: ModelInfo = {
      modelId: 'qwen3-coder-plus',
      name: 'Qwen3 Coder Plus',
      _meta: {
        contextLimit: 262144,
      },
    };

    (
      manager as unknown as {
        baselineAvailableModels: ModelInfo[];
      }
    ).baselineAvailableModels = [
      {
        modelId: 'qwen3-coder-base',
        name: 'Qwen3 Coder Base',
        _meta: {
          contextLimit: 131072,
        },
      },
      selectedModel,
    ];

    (
      manager as unknown as {
        connection: {
          setModel: (modelId: string) => Promise<{ modelId: string }>;
        };
      }
    ).connection = {
      setModel: vi.fn().mockResolvedValue({ modelId: selectedModel.modelId }),
    };

    await manager.setModelFromUi(selectedModel.modelId);

    expect(onModelChanged).toHaveBeenCalledWith(selectedModel);
  });
});

describe('QwenAgentManager.createNewSession', () => {
  it('creates a fresh ACP session when explicitly requested even if one is already active', async () => {
    const manager = new QwenAgentManager();
    const connection = {
      currentSessionId: 'session-1',
      newSession: vi.fn().mockImplementation(async () => {
        connection.currentSessionId = 'session-2';
        return { sessionId: 'session-2' };
      }),
      authenticate: vi.fn(),
    };

    (
      manager as unknown as {
        connection: typeof connection;
      }
    ).connection = connection;

    const newSessionId = await manager.createNewSession('/workspace', {
      forceNew: true,
    } as never);

    expect(connection.newSession).toHaveBeenCalledWith('/workspace');
    expect(newSessionId).toBe('session-2');
  });

  it('creates a distinct fresh session after an in-flight bootstrap when forceNew is requested', async () => {
    const manager = new QwenAgentManager();
    const connection = {
      currentSessionId: null as string | null,
      newSession: vi.fn().mockImplementation(async () => {
        connection.currentSessionId = 'session-2';
        return { sessionId: 'session-2' };
      }),
      authenticate: vi.fn(),
    };

    let resolveBootstrap: ((value: string | null) => void) | undefined;
    const bootstrapSession = new Promise<string | null>((resolve) => {
      resolveBootstrap = (value) => {
        connection.currentSessionId = value;
        resolve(value);
      };
    });

    (
      manager as unknown as {
        connection: typeof connection;
        sessionCreateInFlight: Promise<string | null> | null;
      }
    ).connection = connection;
    (
      manager as unknown as {
        sessionCreateInFlight: Promise<string | null> | null;
      }
    ).sessionCreateInFlight = bootstrapSession;

    const newSessionPromise = manager.createNewSession('/workspace', {
      forceNew: true,
    } as never);

    expect(connection.newSession).not.toHaveBeenCalled();

    resolveBootstrap?.('session-1');

    await expect(newSessionPromise).resolves.toBe('session-2');
    expect(connection.newSession).toHaveBeenCalledTimes(1);
    expect(connection.newSession).toHaveBeenCalledWith('/workspace');
  });
});

describe('QwenAgentManager.getSessionMessages', () => {
  it('projects UserPromptSubmit provenance while mapping JSONL history', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qwen-agent-manager-'));
    const filePath = join(tempDir, 'session.jsonl');
    const timestamp = '2026-03-22T16:48:35.000Z';
    const taggedContext =
      '<qwen:user-prompt-submit-context>\nhook-only context\n</qwen:user-prompt-submit-context>';
    writeFileSync(
      filePath,
      `${JSON.stringify({
        sessionId: 'session-1',
        uuid: 'user-1',
        timestamp,
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'expanded model prompt' }, { text: taggedContext }],
        },
        systemPayload: {
          displayText: 'raw @file prompt',
          hookContext: 'hook-only context',
        },
      })}\n`,
    );

    try {
      const manager = new QwenAgentManager();
      vi.spyOn(manager, 'getSessionList').mockResolvedValue([
        {
          id: 'session-1',
          sessionId: 'session-1',
          filePath,
        },
      ]);

      const messages = await manager.getSessionMessages('session-1');

      expect(messages).toEqual([
        {
          role: 'user',
          content: 'raw @file prompt',
          timestamp: new Date(timestamp).getTime(),
        },
      ]);
      expect(messages[0]?.content).not.toContain('hook-only context');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('QwenAgentManager session-update transcript forwarding', () => {
  function fireSessionUpdate(
    manager: QwenAgentManager,
    notification: Record<string, unknown>,
  ): void {
    const connection = (
      manager as unknown as {
        connection: { onSessionUpdate?: (data: never) => void };
      }
    ).connection;
    connection.onSessionUpdate?.(notification as never);
  }

  it('forwards live session updates verbatim to onTranscriptUpdate', () => {
    const manager = new QwenAgentManager();
    const onTranscriptUpdate = vi.fn();
    manager.onTranscriptUpdate(onTranscriptUpdate);

    const notification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'live chunk' },
      },
    };
    fireSessionUpdate(manager, notification);

    expect(onTranscriptUpdate).toHaveBeenCalledWith(notification);
  });

  it('forwards rehydrating session updates verbatim to onTranscriptUpdate', () => {
    const manager = new QwenAgentManager();
    const onTranscriptUpdate = vi.fn();
    manager.onTranscriptUpdate(onTranscriptUpdate);
    (
      manager as unknown as { rehydratingSessionId: string | null }
    ).rehydratingSessionId = 'session-1';

    const notification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'rehydrated chunk' },
      },
    };
    fireSessionUpdate(manager, notification);

    // Rehydration additionally maps chunks onto discrete onMessage calls,
    // but the raw notification must still reach the transcript feed
    // unchanged so the WebShell timeline sees history replay frames.
    expect(onTranscriptUpdate).toHaveBeenCalledWith(notification);
  });
});
