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
import type {
  ModelInfo,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk';
import type { AskUserQuestionRequest } from '../types/acpTypes.js';
import { decodeSessionListCursor } from '@qwen-code/qwen-code-core';

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

  it('keeps serving from disk with a composite cursor when ACP fails mid-pagination', async () => {
    // The daemon hands out composite "<mtimeMs>:<sessionId>" cursors now, so
    // an ACP failure mid-pagination lands in this fallback holding one.
    // Dropping to an empty page would silently lose the rest of the list.
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const tie = new Date('2026-08-17T00:02:00.000Z').getTime();
    const mk = (sessionId: string, lastUpdated: string) => ({
      sessionId,
      projectHash: 'p',
      startTime: lastUpdated,
      lastUpdated,
      messages: [],
    });
    // Deliberately ascending fixture order: the fallback must order by mtime
    // desc, sessionId asc itself, matching the daemon composite ordering, so
    // a cursor handed over mid-pagination splits the same sequence.
    const stored = [
      mk('550e8400-e29b-41d4-a716-446655440000', '2026-08-17T00:01:00.000Z'),
      mk('550e8400-e29b-41d4-a716-446655440001', '2026-08-17T00:02:00.000Z'),
      mk('550e8400-e29b-41d4-a716-446655440002', '2026-08-17T00:02:00.000Z'),
      mk('550e8400-e29b-41d4-a716-446655440003', '2026-08-17T00:03:00.000Z'),
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    // Composite order: 0003 (00:03), tie members 0001 then 0002 (00:02, id
    // asc), 0000 (00:01). The cursor names tie member 0001, so the remainder
    // is 0002 then 0000.
    const page = await manager.getSessionListPaged({
      cursor: `${tie}:550e8400-e29b-41d4-a716-446655440001`,
      size: 10,
    });

    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440002',
      '550e8400-e29b-41d4-a716-446655440000',
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('serves the remainder when the handed-over cursor carries a fractional mtimeMs', async () => {
    // The daemon mints composite cursors from raw stats.mtimeMs, which is
    // fractional on real filesystems. Rejecting the fractional form at this
    // boundary fails closed and silently truncates the list mid-pagination.
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const tie = new Date('2026-08-17T00:02:00.000Z').getTime() + 0.467;
    const mk = (sessionId: string, mtimeMs: number) => ({
      sessionId,
      projectHash: 'p',
      startTime: new Date(mtimeMs).toISOString(),
      lastUpdated: new Date(mtimeMs).toISOString(),
      mtimeMs,
      messages: [],
    });
    const stored = [
      mk('550e8400-e29b-41d4-a716-446655440000', tie - 60_000),
      mk('550e8400-e29b-41d4-a716-446655440001', tie),
      mk('550e8400-e29b-41d4-a716-446655440002', tie),
      mk('550e8400-e29b-41d4-a716-446655440003', tie + 60_000),
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    // Order: 0003, tie members 0001 then 0002, 0000. Cursor names 0001 with
    // the true fractional mtime; the remainder must be 0002 then 0000.
    const page = await manager.getSessionListPaged({
      cursor: `${tie}:550e8400-e29b-41d4-a716-446655440001`,
      size: 10,
    });

    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440002',
      '550e8400-e29b-41d4-a716-446655440000',
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('serves the remainder for a legacy bare cursor with a fractional mtime', async () => {
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const boundary = new Date('2026-08-17T00:02:00.000Z').getTime() + 0.467;
    const mk = (sessionId: string, mtimeMs: number) => ({
      sessionId,
      projectHash: 'p',
      startTime: new Date(mtimeMs).toISOString(),
      lastUpdated: new Date(mtimeMs).toISOString(),
      mtimeMs,
      messages: [],
    });
    const stored = [
      mk('550e8400-e29b-41d4-a716-446655440000', boundary - 1000),
      mk('550e8400-e29b-41d4-a716-446655440001', boundary),
      mk('550e8400-e29b-41d4-a716-446655440002', boundary + 1000),
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const page = await manager.getSessionListPaged({
      cursor: String(boundary),
      size: 10,
    });

    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440000',
    ]);
  });

  it('mints the fallback cursor at full mtimeMs precision so the ACP handback can match it', async () => {
    // The reverse handover: a fallback-minted cursor must compare exact-equal
    // against the daemon's fractional mtimeMs, or the unserved tie members
    // are filtered out when ACP recovers.
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const tie = new Date('2026-08-17T00:02:00.000Z').getTime() + 0.467;
    const mk = (sessionId: string) => ({
      sessionId,
      projectHash: 'p',
      startTime: new Date(tie).toISOString(),
      lastUpdated: new Date(tie).toISOString(),
      mtimeMs: tie,
      messages: [],
    });
    const stored = [
      mk('550e8400-e29b-41d4-a716-446655440001'),
      mk('550e8400-e29b-41d4-a716-446655440002'),
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const page = await manager.getSessionListPaged({ size: 1 });

    expect(page.nextCursor).toBe(`${tie}:550e8400-e29b-41d4-a716-446655440001`);
    expect(page.hasMore).toBe(true);
  });

  it('pages the filesystem fallback losslessly with the composite cursor it emits', async () => {
    // Slice + cursor advance: page one hands out a composite cursor naming
    // its last row; feeding it back must continue exactly where page one
    // stopped, with no skip or duplicate.
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const tie = new Date('2026-08-17T00:02:00.000Z').getTime();
    const mk = (sessionId: string, lastUpdated: string) => ({
      sessionId,
      projectHash: 'p',
      startTime: lastUpdated,
      lastUpdated,
      messages: [],
    });
    // Ascending with the tie members in reverse id order: only the
    // production-side sort (mtime desc, sessionId asc) can put 0001 ahead of
    // 0002, so the emitted page-one cursor names 0001.
    const stored = [
      mk('550e8400-e29b-41d4-a716-446655440000', '2026-08-17T00:01:00.000Z'),
      mk('550e8400-e29b-41d4-a716-446655440002', '2026-08-17T00:02:00.000Z'),
      mk('550e8400-e29b-41d4-a716-446655440001', '2026-08-17T00:02:00.000Z'),
      mk('550e8400-e29b-41d4-a716-446655440003', '2026-08-17T00:03:00.000Z'),
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const first = await manager.getSessionListPaged({ size: 2 });
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440003',
      '550e8400-e29b-41d4-a716-446655440001',
    ]);
    expect(first.nextCursor).toBe(
      `${tie}:550e8400-e29b-41d4-a716-446655440001`,
    );
    expect(first.hasMore).toBe(true);

    const second = await manager.getSessionListPaged({
      cursor: first.nextCursor,
      size: 2,
    });
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440002',
      '550e8400-e29b-41d4-a716-446655440000',
    ]);
    expect(second.hasMore).toBe(false);
  });

  it('still serves valid rows when a legacy row has no sessionId or timestamps', async () => {
    // A legacy session-*.json row can lack sessionId/lastUpdated entirely.
    // The fallback must drop it at ingestion rather than throw inside the
    // comparator (which would empty every valid session behind the catch).
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const valid = (sessionId: string, lastUpdated: string) => ({
      sessionId,
      projectHash: 'p',
      startTime: lastUpdated,
      lastUpdated,
      messages: [],
    });
    const stored = [
      { projectHash: 'p', messages: [] }, // no sessionId, no timestamps
      { projectHash: 'p', messages: [] }, // a second one to force a tie at 0
      valid('550e8400-e29b-41d4-a716-446655440000', '2026-08-17T00:01:00.000Z'),
      valid('550e8400-e29b-41d4-a716-446655440001', '2026-08-17T00:02:00.000Z'),
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const page = await manager.getSessionListPaged({ size: 10 });

    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440000',
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('advances past an unmintable legacy row at the page boundary without truncating', async () => {
    // A legacy session-*.json row is displayable, but its basename cannot be
    // encoded as a core composite cursor. If it lands at the nominal boundary
    // the fallback must include rows until it reaches a mintable boundary,
    // report hasMore truthfully, and continue without a duplicate.
    const manager = new QwenAgentManager();
    (manager as unknown as { connection: unknown }).connection = {
      listSessions: vi.fn().mockRejectedValue(new Error('ACP unavailable')),
    };
    const row = (sessionId: string, mtimeMs: number, fileName: string) => ({
      sessionId,
      projectHash: 'p',
      startTime: new Date(mtimeMs).toISOString(),
      lastUpdated: new Date(mtimeMs).toISOString(),
      mtimeMs,
      filePath: join('/chats', fileName),
      messages: [],
    });
    const newest = '550e8400-e29b-41d4-a716-446655440001';
    const legacy = '550e8400-e29b-41d4-a716-446655440002';
    const boundary = '550e8400-e29b-41d4-a716-446655440003';
    const oldest = '550e8400-e29b-41d4-a716-446655440004';
    const stored = [
      row(newest, 4_000, `${newest}.jsonl`),
      row(legacy, 3_000, `session-2026-05-17-${legacy}.json`),
      row(boundary, 2_000, `${boundary}.jsonl`),
      row(oldest, 1_000, `${oldest}.jsonl`),
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const first = await manager.getSessionListPaged({ size: 2 });

    // The nominal boundary is the legacy row, so page one expands by one to
    // reach the next mintable .jsonl row.
    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      newest,
      legacy,
      boundary,
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(decodeSessionListCursor(first.nextCursor!)).toEqual({
      mtime: 2_000,
      sessionId: boundary,
    });

    const second = await manager.getSessionListPaged({
      cursor: first.nextCursor,
      size: 2,
    });
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      oldest,
    ]);
    expect(second.hasMore).toBe(false);
    expect(
      new Set(
        [...first.sessions, ...second.sessions].map(
          (session) => session.sessionId,
        ),
      ).size,
    ).toBe(4);
  });

  it('still fails closed on a malformed cursor in the filesystem fallback', async () => {
    // Garbage that parses as neither legacy numeric nor composite:
    // re-serving page one would duplicate rows in the webview, so the
    // fallback returns an empty page instead.
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
    ];
    (manager as unknown as { sessionReader: unknown }).sessionReader = {
      getAllSessions: vi.fn().mockResolvedValue(stored),
      getSessionTitle: vi.fn().mockReturnValue('t'),
    };

    const page = await manager.getSessionListPaged({
      cursor: 'not-a-cursor',
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

describe('QwenAgentManager input fallbacks', () => {
  it('cancels when no input callbacks are registered', async () => {
    const manager = new QwenAgentManager();
    const connection = (
      manager as unknown as {
        connection: {
          onPermissionRequest: (
            request: RequestPermissionRequest,
          ) => Promise<{ optionId: string }>;
          onAskUserQuestion: (
            request: AskUserQuestionRequest,
          ) => Promise<{ optionId: string }>;
        };
      }
    ).connection;

    await expect(
      connection.onPermissionRequest({
        sessionId: 'session-1',
        options: [
          {
            optionId: 'proceed_once',
            name: 'Allow once',
            kind: 'allow_once',
          },
          {
            optionId: 'reject_once',
            name: 'Reject',
            kind: 'reject_once',
          },
        ],
        toolCall: {
          toolCallId: 'tool-call-1',
          title: 'Run command',
          kind: 'execute',
          status: 'pending',
        },
      }),
    ).resolves.toEqual({ optionId: 'cancel' });

    await expect(
      connection.onAskUserQuestion({
        sessionId: 'session-1',
        questions: [],
      }),
    ).resolves.toEqual({ optionId: 'cancel' });
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
