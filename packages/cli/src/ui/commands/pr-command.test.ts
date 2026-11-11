/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prCommand } from './pr-command.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const mocks = vi.hoisted(() => ({
  readSessionPrs: vi.fn(),
  upsertSessionPrs: vi.fn(),
  isValidSessionPrUrl: vi.fn(),
  fetchPullRequestByReference: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core/services/session-pr-service.js', () => ({
  readSessionPrs: mocks.readSessionPrs,
  upsertSessionPrs: mocks.upsertSessionPrs,
  isValidSessionPrUrl: mocks.isValidSessionPrUrl,
}));

vi.mock('@qwen-code/qwen-code-core/utils/github-prs.js', () => ({
  fetchPullRequestByReference: mocks.fetchPullRequestByReference,
}));

const SESSION_ID = 'sess-pr-1';
const PR_PATH = `/tmp/chats/${SESSION_ID}.active.pr.json`;

function createContext() {
  const sessionService = {
    getPrSessionPathForArchiveState: vi
      .fn()
      .mockImplementation((_id: string, state: string) =>
        state === 'active'
          ? PR_PATH
          : `/tmp/chats/${SESSION_ID}.archived.pr.json`,
      ),
    getSessionLocation: vi.fn().mockResolvedValue('active'),
    emitSessionPrBound: vi.fn(),
  };
  const context = createMockCommandContext({
    services: {
      config: {
        getSessionService: vi.fn().mockReturnValue(sessionService),
        getSessionId: vi.fn().mockReturnValue(SESSION_ID),
        getTargetDir: vi.fn().mockReturnValue('/repo'),
      },
    },
  });
  return { context, sessionService };
}

const RESOLVED = {
  number: 16865,
  url: 'https://github.com/QwenLM/qwen-code/pull/16865',
  state: 'open' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSessionPrs.mockResolvedValue(null);
  mocks.upsertSessionPrs.mockImplementation(
    async (
      _path: string,
      candidates: Array<{ number: number; url: string }>,
    ) => ({
      prs: candidates.map((candidate) => ({
        ...candidate,
        createdAt: '2026-11-11T00:00:00.000Z',
      })),
      added: candidates.map((candidate) => candidate.number),
      alreadyBound: [],
      unresolved: [],
    }),
  );
  mocks.isValidSessionPrUrl.mockImplementation((url: string) =>
    /^https?:\/\//i.test(url),
  );
  mocks.fetchPullRequestByReference.mockResolvedValue(RESOLVED);
});

describe('prCommand', () => {
  it('declares all execution modes', () => {
    expect(prCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('returns error when config is not loaded', async () => {
    const context = createMockCommandContext({ services: { config: null } });
    const result = await prCommand.action?.(context, '16865');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Config'),
    });
  });

  it('lists nothing and shows usage when no argument and no bindings', async () => {
    const { context } = createContext();
    const result = await prCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('No PRs bound to this session.'),
    });
    expect((result as { content: string }).content).toContain('/pr');
    expect(mocks.upsertSessionPrs).not.toHaveBeenCalled();
  });

  it('lists bound PRs when no argument', async () => {
    mocks.readSessionPrs.mockResolvedValue([
      { ...RESOLVED, createdAt: 'x' },
      {
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        state: 'merged',
        createdAt: 'y',
      },
    ]);
    const { context } = createContext();
    const result = await prCommand.action?.(context, '  ');
    const content = (result as { content: string }).content;
    expect(content).toContain('#16865 (open)');
    expect(content).toContain('#42 (merged)');
  });

  it('rejects an invalid reference', async () => {
    const { context } = createContext();
    const result = await prCommand.action?.(context, 'not-a-pr');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Invalid PR reference'),
    });
    expect(mocks.fetchPullRequestByReference).not.toHaveBeenCalled();
    expect(mocks.upsertSessionPrs).not.toHaveBeenCalled();
  });

  it('rejects PR 0 and leading zeros', async () => {
    const { context } = createContext();
    for (const input of ['0', '0123']) {
      const result = await prCommand.action?.(context, input);
      expect(result?.type).toBe('message');
      expect((result as { messageType: string }).messageType).toBe('error');
    }
  });

  it('binds a bare number with gh-resolved url and state', async () => {
    const { context, sessionService } = createContext();
    const result = await prCommand.action?.(context, '16865');
    expect(mocks.fetchPullRequestByReference).toHaveBeenCalledWith(
      '/repo',
      '16865',
    );
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(PR_PATH, [
      { ...RESOLVED, source: 'create' },
    ]);
    expect(sessionService.emitSessionPrBound).toHaveBeenCalledWith(SESSION_ID, {
      number: RESOLVED.number,
      url: RESOLVED.url,
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('#16865'),
    });
  });

  it('binds the #N shorthand', async () => {
    const { context } = createContext();
    await prCommand.action?.(context, '#16865');
    expect(mocks.fetchPullRequestByReference).toHaveBeenCalledWith(
      '/repo',
      '16865',
    );
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(PR_PATH, [
      { ...RESOLVED, source: 'create' },
    ]);
  });

  it('binds a URL form using gh canonicalization', async () => {
    const { context } = createContext();
    const input = 'https://github.com/QwenLM/qwen-code/pull/16865/files';
    await prCommand.action?.(context, input);
    expect(mocks.fetchPullRequestByReference).toHaveBeenCalledWith(
      '/repo',
      input,
    );
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(PR_PATH, [
      { ...RESOLVED, source: 'create' },
    ]);
  });

  it('degrades to the user URL without state when gh fails on a URL', async () => {
    mocks.fetchPullRequestByReference.mockResolvedValue(undefined);
    const { context, sessionService } = createContext();
    const input = 'https://github.example.com/o/r/pull/5';
    const result = await prCommand.action?.(context, input);
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(PR_PATH, [
      { number: 5, url: input, source: 'create' },
    ]);
    expect(sessionService.emitSessionPrBound).toHaveBeenCalled();
    expect((result as { messageType: string }).messageType).toBe('info');
  });

  it('errors when gh fails on a bare number', async () => {
    mocks.fetchPullRequestByReference.mockResolvedValue(undefined);
    const { context } = createContext();
    const result = await prCommand.action?.(context, '999999999');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('full PR URL'),
    });
    expect(mocks.upsertSessionPrs).not.toHaveBeenCalled();
  });

  it('reports already-bound without notifying', async () => {
    mocks.upsertSessionPrs.mockResolvedValue({
      prs: [{ ...RESOLVED, createdAt: 'old' }],
      added: [],
      alreadyBound: [RESOLVED.number],
      unresolved: [],
    });
    const { context, sessionService } = createContext();
    const result = await prCommand.action?.(context, '16865');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('already bound'),
    });
    expect(sessionService.emitSessionPrBound).not.toHaveBeenCalled();
  });

  it('writes to the archived sidecar when the session is archived', async () => {
    const { context, sessionService } = createContext();
    sessionService.getSessionLocation.mockResolvedValue('archived');
    await prCommand.action?.(context, '16865');
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(
      `/tmp/chats/${SESSION_ID}.archived.pr.json`,
      [{ ...RESOLVED, source: 'create' }],
    );
  });

  it('surfaces a persistence failure as an error message', async () => {
    mocks.upsertSessionPrs.mockRejectedValue(new Error('EACCES'));
    const { context } = createContext();
    const result = await prCommand.action?.(context, '16865');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('EACCES'),
    });
  });

  it('errors when the upsert declines the entry', async () => {
    mocks.upsertSessionPrs.mockResolvedValue({
      prs: [],
      added: [],
      alreadyBound: [],
      unresolved: [RESOLVED.number],
    });
    const { context } = createContext();
    const result = await prCommand.action?.(context, '16865');
    expect((result as { messageType: string }).messageType).toBe('error');
  });

  it('falls back to the active sidecar when the location query fails', async () => {
    const { context, sessionService } = createContext();
    sessionService.getSessionLocation.mockRejectedValue(new Error('busy'));
    const result = await prCommand.action?.(context, '16865');
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(PR_PATH, [
      { ...RESOLVED, source: 'create' },
    ]);
    expect((result as { messageType: string }).messageType).toBe('info');
  });

  it('shows usage when the sidecar read fails in list mode', async () => {
    mocks.readSessionPrs.mockRejectedValue(new Error('EACCES'));
    const { context } = createContext();
    const result = await prCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('No PRs bound to this session.'),
    });
  });

  it('errors when a degraded URL fails the url shape guard', async () => {
    mocks.fetchPullRequestByReference.mockResolvedValue(undefined);
    mocks.isValidSessionPrUrl.mockReturnValue(false);
    const { context } = createContext();
    const result = await prCommand.action?.(
      context,
      'https://github.com/o/r/pull/5',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Could not resolve PR'),
    });
    expect(mocks.upsertSessionPrs).not.toHaveBeenCalled();
  });

  it('lists archived bindings when the session is archived', async () => {
    const { context, sessionService } = createContext();
    sessionService.getSessionLocation.mockResolvedValue('archived');
    mocks.readSessionPrs.mockImplementation(async (path: string) =>
      path.includes('.archived.') ? [{ ...RESOLVED, createdAt: 'x' }] : null,
    );
    const result = await prCommand.action?.(context, '');
    expect((result as { content: string }).content).toContain('#16865 (open)');
  });
});
