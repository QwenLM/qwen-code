/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import {
  collectGitContext,
  takeSystemContextPrefetch,
} from '../../context/system-context.js';
import type { Message } from '../../protocol/transcript/message.js';
import { normalizeMessagesForAPI } from '../../protocol/provider/request-converter.js';
import { runWithCwdOverride } from '../../utils/Shell.js';
import { createAttachmentMessage } from '../factory.js';
import { createAttachmentContext } from '../get-attachments.js';
import { SessionContextAttachment } from '../models/session-context-attachment.js';
import { getSessionContextAttachments } from './session-context-generators.js';

vi.mock('../../context/system-context.js', () => ({
  collectGitContext: vi.fn(),
  takeSystemContextPrefetch: vi.fn(),
}));

const root = path.resolve('/session-context-test/project');
const child = path.join(root, 'worktree');
const initialGit = 'Current branch: main\n\nRecent commits:\nabc123 initial';
const latestGit = 'Current branch: feature\n\nRecent commits:\ndef456 latest';

function context() {
  const ctx = createAttachmentContext(root);
  ctx.config = {
    getTargetDir: () => root,
    getWorkingDir: () => root,
  } as Config;
  return ctx;
}

const saved = (gitStatus?: string) =>
  createAttachmentMessage(
    new SessionContextAttachment({
      type: 'session_context',
      context: gitStatus === undefined ? {} : { gitStatus },
    }),
  );

describe('session context attachments', () => {
  beforeEach(() => {
    vi.mocked(collectGitContext)
      .mockReset()
      .mockResolvedValue({ gitStatus: initialGit });
    vi.mocked(takeSystemContextPrefetch).mockReset();
  });

  const announce = (
    history: Message[] = [],
    options: Omit<
      Parameters<typeof getSessionContextAttachments>[2],
      'sessionId'
    > = {},
    cwd = root,
  ) =>
    runWithCwdOverride(cwd, async () =>
      (
        await getSessionContextAttachments(context(), history, {
          sessionId: 'session',
          ...options,
        })
      ).map(createAttachmentMessage),
    );

  it('projects and restores Git as a meta user reminder', async () => {
    const history = await announce();
    expect(history).toHaveLength(1);
    expect(history[0].attachment).toMatchObject({
      type: 'session_context',
      context: { gitStatus: initialGit },
    });
    const projected = normalizeMessagesForAPI(history);
    expect(projected[0].role).toBe('user');
    expect(JSON.stringify(projected)).toContain('# gitStatus');
    expect(JSON.stringify(projected)).toContain('<system-reminder>');
    const restored: Message[] = JSON.parse(JSON.stringify(history));
    expect(normalizeMessagesForAPI(restored)).toEqual(projected);
    expect(await announce(restored)).toEqual([]);
    expect(collectGitContext).toHaveBeenCalledTimes(1);
  });

  it('reuses the retained snapshot across commits, cd, resume and fork', async () => {
    const history = [saved(initialGit)];
    vi.mocked(collectGitContext).mockResolvedValue({ gitStatus: latestGit });
    for (const isSubagent of [false, true]) {
      expect(await announce(history, { isSubagent }, child)).toEqual([]);
    }
    expect(collectGitContext).not.toHaveBeenCalled();
    expect(takeSystemContextPrefetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(normalizeMessagesForAPI(history))).toContain(
      'abc123 initial',
    );
  });

  it('collects fresh state only when compaction or rewind removes the snapshot', async () => {
    const history = await announce();
    vi.mocked(collectGitContext).mockResolvedValue({ gitStatus: latestGit });
    expect(await announce(history)).toEqual([]);
    const [refreshed] = await announce([]);
    expect(refreshed.attachment).toMatchObject({
      context: { gitStatus: latestGit },
    });
    expect(collectGitContext).toHaveBeenCalledTimes(2);
  });

  it('does not advance the baseline for an undelivered candidate', async () => {
    await announce();
    vi.mocked(collectGitContext).mockResolvedValue({ gitStatus: latestGit });
    expect((await announce())[0].attachment).toMatchObject({
      context: { gitStatus: latestGit },
    });
    expect(collectGitContext).toHaveBeenCalledTimes(2);
  });

  it('uses startup prefetch once and discards it when history already has a snapshot', async () => {
    vi.mocked(takeSystemContextPrefetch).mockReturnValueOnce(
      Promise.resolve({ gitStatus: initialGit }),
    );
    const history = await announce();
    expect(collectGitContext).not.toHaveBeenCalled();
    vi.mocked(takeSystemContextPrefetch).mockReturnValueOnce(
      Promise.resolve({ gitStatus: 'unused startup' }),
    );
    expect(await announce(history)).toEqual([]);
    vi.mocked(collectGitContext).mockResolvedValue({ gitStatus: latestGit });
    expect((await announce())[0].attachment).toMatchObject({
      context: { gitStatus: latestGit },
    });
  });

  it('collects a fresh child from its own worktree without consuming parent prefetch', async () => {
    await announce([], { isSubagent: true }, child);
    expect(collectGitContext).toHaveBeenCalledWith(child, undefined);
    expect(takeSystemContextPrefetch).not.toHaveBeenCalled();
  });

  it.each(['non-git', 'omitted', 'failed'])(
    'persists an empty %s baseline without emitting text or retrying each turn',
    async (reason) => {
      if (reason === 'failed')
        vi.mocked(collectGitContext).mockRejectedValue(
          new Error('probe failed'),
        );
      else vi.mocked(collectGitContext).mockResolvedValue({});
      const history = await announce([], {
        omitGitStatus: reason === 'omitted',
      });
      expect(history).toHaveLength(1);
      expect(history[0].attachment).toMatchObject({ context: {} });
      expect(normalizeMessagesForAPI(history)).toEqual([]);
      expect(await announce(history)).toEqual([]);
      expect(collectGitContext).toHaveBeenCalledTimes(
        reason === 'omitted' ? 0 : 1,
      );
    },
  );

  it('does not drop an inherited snapshot when new collection is omitted', async () => {
    expect(
      await announce([saved(initialGit)], {
        omitGitStatus: true,
        isSubagent: true,
      }),
    ).toEqual([]);
    expect(collectGitContext).not.toHaveBeenCalled();
  });

  it('replaces a malformed latest snapshot instead of falling back to an older one', async () => {
    const invalid = JSON.parse(JSON.stringify(saved()));
    invalid.attachment.context = { gitStatus: 42 };
    expect(normalizeMessagesForAPI([invalid])).toEqual([]);
    vi.mocked(collectGitContext).mockResolvedValue({ gitStatus: latestGit });
    expect(
      (await announce([saved(initialGit), invalid]))[0].attachment,
    ).toMatchObject({ context: { gitStatus: latestGit } });
  });

  it.each([false, true])(
    'announces changed non-Git fields for subagent=%s without refreshing Git',
    async (isSubagent) => {
      const history = [
        createAttachmentMessage(
          new SessionContextAttachment({
            type: 'session_context',
            context: {
              gitStatus: initialGit,
              userEmail: 'old@example.test',
              attachedProject: 'Project',
            },
          }),
        ),
      ];
      const options = {
        isSubagent,
        omitGitStatus: true,
        sessionContext: {
          context: { userEmail: 'new@example.test' },
          reason: 'account_change' as const,
        },
      };
      const changed = await announce(history, options);
      expect(changed[0].attachment).toEqual(
        expect.objectContaining({
          context: { gitStatus: initialGit, userEmail: 'new@example.test' },
          changed: true,
          reason: 'account_change',
        }),
      );
      expect(collectGitContext).not.toHaveBeenCalled();
      const restored: Message[] = JSON.parse(
        JSON.stringify([...history, ...changed]),
      );
      expect(await announce(restored, options)).toEqual([]);
      // No resolver means the inherited non-Git fields remain intact too.
      expect(await announce(restored, { isSubagent })).toEqual([]);
    },
  );

  it('does not announce unchanged values just because the refresh reason changed', async () => {
    const history = await announce([], {
      sessionContext: { context: { attachedProject: 'Project' } },
    });
    expect(history[0].attachment).not.toHaveProperty('changed');
    expect(history[0].attachment).not.toHaveProperty('reason');
    expect(
      await announce(history, {
        sessionContext: {
          context: { attachedProject: 'Project' },
          reason: 'settings_sync',
        },
      }),
    ).toEqual([]);
    expect(collectGitContext).toHaveBeenCalledTimes(1);
  });

  it('announces removal of the last field and retains the empty baseline', async () => {
    const previous = createAttachmentMessage(
      new SessionContextAttachment({
        type: 'session_context',
        context: { attachedProject: 'Old project' },
      }),
    );
    const options = {
      sessionContext: { context: {}, reason: 'project_reread' as const },
    };
    const [removed] = await announce([previous], options);
    expect(removed.attachment).toEqual(
      expect.objectContaining({
        context: {},
        changed: true,
        reason: 'project_reread',
      }),
    );
    expect(JSON.stringify(normalizeMessagesForAPI([removed]))).toContain(
      'no longer apply',
    );
    expect(await announce([previous, removed], options)).toEqual([]);
    expect(collectGitContext).not.toHaveBeenCalled();
  });

  it('tolerates unknown reason metadata when restoring a changed snapshot', async () => {
    const previous = JSON.parse(JSON.stringify(saved(initialGit)));
    previous.attachment.changed = true;
    previous.attachment.reason = 'a_future_reason';
    expect(await announce([previous])).toEqual([]);
    expect(collectGitContext).not.toHaveBeenCalled();
  });

  it('uses retained context as the baseline, even if only a changed snapshot survives compaction', async () => {
    const previous = createAttachmentMessage(
      new SessionContextAttachment({
        type: 'session_context',
        context: { gitStatus: initialGit, attachedProject: 'Retained' },
        changed: true,
        reason: 'settings_sync',
      }),
    );
    const [changed] = await announce([previous], {
      reason: 'compaction',
      sessionContext: { context: { attachedProject: 'After compact' } },
    });
    expect(changed.attachment).toEqual(
      expect.objectContaining({
        context: { gitStatus: initialGit, attachedProject: 'After compact' },
        changed: true,
        reason: 'compaction',
      }),
    );
    expect(collectGitContext).not.toHaveBeenCalled();
    const [fresh] = await announce([], {
      reason: 'compaction',
      sessionContext: { context: { attachedProject: 'After compact' } },
    });
    expect(fresh.attachment).not.toHaveProperty('changed');
    expect(fresh.attachment).not.toHaveProperty('reason');
    expect(collectGitContext).toHaveBeenCalledTimes(1);
  });

  it('lets an auxiliary query announce initially but never replace an inherited snapshot', async () => {
    const options = {
      isAuxiliary: true,
      sessionContext: { context: { userEmail: 'helper@example.test' } },
    };
    expect(await announce([saved(initialGit)], options)).toEqual([]);
    expect(collectGitContext).not.toHaveBeenCalled();
    const [fresh] = await announce([], options);
    expect(fresh.attachment).toEqual(
      expect.objectContaining({
        context: { gitStatus: initialGit, userEmail: 'helper@example.test' },
      }),
    );
    expect(fresh.attachment).not.toHaveProperty('changed');
  });
});
