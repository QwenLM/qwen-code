/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prCommand } from './pr-command.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const mocks = vi.hoisted(() => ({
  readSessionPrsDetailed: vi.fn(),
  upsertSessionPrs: vi.fn(),
  isValidSessionPrUrl: vi.fn(),
  fetchPullRequestByReference: vi.fn(),
  pullRequestViewUrl: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core/services/session-pr-service.js', () => ({
  readSessionPrsDetailed: mocks.readSessionPrsDetailed,
  upsertSessionPrs: mocks.upsertSessionPrs,
  isValidSessionPrUrl: mocks.isValidSessionPrUrl,
}));

vi.mock('@qwen-code/qwen-code-core/utils/github-prs.js', () => ({
  fetchPullRequestByReference: mocks.fetchPullRequestByReference,
  pullRequestViewUrl: mocks.pullRequestViewUrl,
}));

const SESSION_ID = 'sess-pr-1';
const PR_PATH = `/tmp/chats/${SESSION_ID}.active.pr.json`;
const ARCHIVED_PR_PATH = `/tmp/chats/${SESSION_ID}.archived.pr.json`;

function createContext() {
  const sessionService = {
    // Echo the id so a regression deriving the path from another session
    // is visible to the toHaveBeenCalledWith assertions.
    getPrSessionPathForArchiveState: vi
      .fn()
      .mockImplementation(
        (id: string, state: string) => `/tmp/chats/${id}.${state}.pr.json`,
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
  mocks.readSessionPrsDetailed.mockResolvedValue({ status: 'absent' });
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
  mocks.fetchPullRequestByReference.mockResolvedValue({
    status: 'pr',
    ...RESOLVED,
  });
  mocks.pullRequestViewUrl.mockImplementation((url: string) => {
    const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+)/i.exec(url);
    return match ? match[1] : undefined;
  });
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
    mocks.readSessionPrsDetailed.mockResolvedValue({
      status: 'ok',
      prs: [
        { ...RESOLVED, createdAt: 'x' },
        {
          number: 42,
          url: 'https://github.com/o/r/pull/42',
          state: 'merged',
          createdAt: 'y',
        },
      ],
    });
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
    expect(sessionService.getPrSessionPathForArchiveState).toHaveBeenCalledWith(
      SESSION_ID,
      'active',
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
    mocks.fetchPullRequestByReference.mockResolvedValue({
      status: 'error',
      reason: 'failed',
    });
    const { context, sessionService } = createContext();
    const input = 'https://github.example.com/o/r/pull/5';
    const result = await prCommand.action?.(context, input);
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(PR_PATH, [
      { number: 5, url: input, source: 'create' },
    ]);
    expect(sessionService.emitSessionPrBound).toHaveBeenCalledWith(SESSION_ID, {
      number: 5,
      url: input,
    });
    expect((result as { messageType: string }).messageType).toBe('info');
  });

  it('normalizes a degraded /files URL to the canonical sidecar key', async () => {
    mocks.fetchPullRequestByReference.mockResolvedValue({
      status: 'error',
      reason: 'failed',
    });
    const { context } = createContext();
    await prCommand.action?.(
      context,
      'https://github.com/o/r/pull/5/files?x=1',
    );
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(PR_PATH, [
      { number: 5, url: 'https://github.com/o/r/pull/5', source: 'create' },
    ]);
  });

  it('errors when gh fails on a bare number', async () => {
    mocks.fetchPullRequestByReference.mockResolvedValue({
      status: 'error',
      reason: 'failed',
    });
    const { context } = createContext();
    const result = await prCommand.action?.(context, '999999999');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('full PR URL'),
    });
    expect(mocks.upsertSessionPrs).not.toHaveBeenCalled();
  });

  it('names the cause when gh is unavailable or timed out', async () => {
    for (const reason of ['unavailable', 'timeout'] as const) {
      mocks.fetchPullRequestByReference.mockResolvedValue({
        status: 'error',
        reason,
      });
      const { context } = createContext();
      const result = await prCommand.action?.(context, '16865');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('unavailable or timed out'),
      });
      expect(mocks.upsertSessionPrs).not.toHaveBeenCalled();
    }
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
    expect(sessionService.getPrSessionPathForArchiveState).toHaveBeenCalledWith(
      SESSION_ID,
      'archived',
    );
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(ARCHIVED_PR_PATH, [
      { ...RESOLVED, source: 'create' },
    ]);
  });

  it('re-resolves the archive location after the gh round trip', async () => {
    // The ordering the source comment insists on: a session archived while
    // gh is in flight must land on the archived sidecar, not the active one
    // read before the round trip.
    const { context, sessionService } = createContext();
    mocks.fetchPullRequestByReference.mockImplementation(async () => {
      sessionService.getSessionLocation.mockResolvedValue('archived');
      return { status: 'pr', ...RESOLVED };
    });
    await prCommand.action?.(context, '16865');
    expect(mocks.upsertSessionPrs).toHaveBeenCalledWith(ARCHIVED_PR_PATH, [
      { ...RESOLVED, source: 'create' },
    ]);
  });

  it('reports success even when the catalog notification throws', async () => {
    const { context, sessionService } = createContext();
    sessionService.emitSessionPrBound.mockImplementation(() => {
      throw new Error('catalog disposed');
    });
    const result = await prCommand.action?.(context, '16865');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('Bound PR #16865'),
    });
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

  it('reports a read failure in list mode instead of an empty list', async () => {
    mocks.readSessionPrsDetailed.mockRejectedValue(new Error('EACCES'));
    const { context } = createContext();
    const result = await prCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Could not read the PR bindings'),
    });
  });

  it('reports a corrupt sidecar in list mode instead of an empty list', async () => {
    mocks.readSessionPrsDetailed.mockResolvedValue({ status: 'invalid' });
    const { context } = createContext();
    const result = await prCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Could not read the PR bindings'),
    });
  });

  it('errors when a degraded URL fails the url shape guard', async () => {
    mocks.fetchPullRequestByReference.mockResolvedValue({
      status: 'error',
      reason: 'failed',
    });
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
    mocks.readSessionPrsDetailed.mockImplementation(async (path: string) =>
      path.includes('.archived.')
        ? { status: 'ok', prs: [{ ...RESOLVED, createdAt: 'x' }] }
        : { status: 'absent' },
    );
    const result = await prCommand.action?.(context, '');
    expect((result as { content: string }).content).toContain('#16865 (open)');
  });
});
