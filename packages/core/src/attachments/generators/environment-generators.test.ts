/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import type { Message } from '../../protocol/transcript/message.js';
import { normalizeMessagesForAPI } from '../../protocol/provider/request-converter.js';
import { createPromptRenderInputs } from '../../prompts/render-inputs.js';
import { SystemPromptAssembler } from '../../prompts/system-prompt-assembler.js';
import {
  GitMetadataProbeTimeoutError,
  findGitRootAsync,
  resolveGitRepositoryLayout,
} from '../../utils/gitUtils.js';
import {
  getCwd,
  initializeShellSession,
  runWithCwdOverride,
  runWithShellSession,
  setCwd,
} from '../../utils/Shell.js';
import { WorkspaceContext } from '../../utils/workspaceContext.js';
import {
  createAttachmentContext,
  getAttachmentMessages,
} from '../get-attachments.js';
import { createAttachmentMessage } from '../factory.js';
import { normalizeAttachmentsForAPI } from '../normalize.js';
import { restoreAttachmentTranscriptState } from '../transcript-state.js';
import type { AttachmentToolUseContext } from '../types.js';
import { getEnvironmentAttachments } from './environment-generators.js';

vi.mock('../../utils/gitUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/gitUtils.js')>()),
  resolveGitRepositoryLayout: vi.fn(),
  findGitRootAsync: vi.fn(),
}));

function userText(message: ModelStreamUserMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
}

describe('environment attachments', () => {
  let root: string;
  let child: string;
  let other: string;
  let ctx: AttachmentToolUseContext;
  let workspace: WorkspaceContext;

  beforeEach(() => {
    root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'environment-test-')),
    );
    child = path.join(root, 'child');
    other = path.join(root, 'other');
    mkdirSync(child);
    mkdirSync(other);
    workspace = new WorkspaceContext(root);
    ctx = createAttachmentContext(root);
    ctx.config = {
      getTargetDir: () => root,
      getWorkingDir: () => root,
      getWorkspaceContext: () => workspace,
      getGoalManager: () => undefined,
      getLanguage: () => undefined,
      getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
    } as unknown as Config;
    initializeShellSession(ctx.config, root);
    vi.mocked(resolveGitRepositoryLayout).mockReset().mockResolvedValue(null);
    vi.mocked(findGitRootAsync).mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const announce = async (
    context: AttachmentToolUseContext,
    messages: Message[] = [],
  ) =>
    (await getEnvironmentAttachments(context, messages)).map(
      createAttachmentMessage,
    );

  function cd(directory: string) {
    runWithShellSession(ctx.config!, () => setCwd(directory));
  }

  it('keeps a successful Git/worktree discovery across later transient probe failures', async () => {
    vi.mocked(findGitRootAsync).mockResolvedValue(root);
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
      isWorktree: true,
    } as NonNullable<Awaited<ReturnType<typeof resolveGitRepositoryLayout>>>);
    const history = await announce(ctx);
    vi.mocked(findGitRootAsync).mockRejectedValue(new Error('late I/O error'));
    vi.mocked(resolveGitRepositoryLayout).mockRejectedValue(
      new GitMetadataProbeTimeoutError(2000),
    );
    expect(await announce(ctx, history)).toEqual([]);
    expect(findGitRootAsync).toHaveBeenCalledOnce();
    expect(resolveGitRepositoryLayout).toHaveBeenCalledOnce();
    const [restored] = await getEnvironmentAttachments(ctx);
    expect(restored.snapshot).toMatchObject({
      isGitRepo: true,
      isWorktree: true,
    });
  });

  it('keeps Git detection independent of unreadable worktree metadata', async () => {
    vi.mocked(findGitRootAsync).mockResolvedValue(root);
    vi.mocked(resolveGitRepositoryLayout).mockRejectedValue(
      new Error('commondir unavailable'),
    );
    const [attachment] = await getEnvironmentAttachments(ctx);
    expect(attachment.snapshot).toMatchObject({
      isGitRepo: true,
      isWorktree: false,
    });
  });

  it('honors active worktree state independently of Git discovery and observes leaving it', async () => {
    const settings = vi.fn().mockReturnValue({ path: root, hookBased: true });
    Object.assign(ctx.config!, { getWorktreeSettings: settings });
    vi.mocked(findGitRootAsync).mockRejectedValue(new Error('unavailable'));
    const history = await announce(ctx);
    expect(history[0].attachment).toMatchObject({
      snapshot: { isGitRepo: false, isWorktree: true },
    });
    settings.mockReturnValue(undefined);
    const [left] = await getEnvironmentAttachments(ctx, history);
    expect(left.changes).toEqual([{ field: 'isWorktree' }]);
  });

  it('sends a full baseline, retries undelivered candidates, and suppresses unchanged announcements', async () => {
    const first = await announce(ctx);
    expect(first).toHaveLength(1);
    expect(first[0].attachment).toMatchObject({
      type: 'environment',
      snapshot: { workingDirectory: root, additionalWorkingDirectories: [] },
    });
    expect(first[0].attachment).not.toHaveProperty('changes');
    expect(normalizeAttachmentsForAPI(first)[0].content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('# Environment\n'),
    });
    expect(await announce(ctx)).toHaveLength(1);
    expect(await announce(ctx, first)).toEqual([]);
  });

  it.each(['full', 'lean'] as const)(
    'sends the initial environment only in attachments with the %s system prompt',
    async (bundle) => {
      const renderInputs = createPromptRenderInputs(
        {
          config: ctx.config,
          toolRegistry: { getAllToolNames: () => [] },
        } as unknown as AgentLoopContext,
        'default',
        'sdk',
        { owner: 'none' },
      );
      const system = await new SystemPromptAssembler({
        sessionId: `environment-${bundle}`,
      }).build({
        source: 'default',
        bundle,
        surface: 'sdk',
        enabledSectionGates: [],
        renderInputs,
      });
      const initial = await getAttachmentMessages(
        'start',
        ctx,
        [],
        null,
        { skipSkillDiscovery: true },
        undefined,
        undefined,
        [],
      );
      const systemText = system.join('\n\n');
      const request = JSON.stringify({
        system,
        messages: normalizeMessagesForAPI(initial),
      });
      expect(systemText).not.toContain('# Environment');
      expect(systemText).not.toContain('Primary working directory:');
      expect(request.match(/# Environment/g)).toHaveLength(1);
      expect(request.match(/Primary working directory:/g)).toHaveLength(1);
      expect(request).toContain(JSON.stringify(root).slice(1, -1));
    },
  );

  it('diffs live Shell cwd against the last announced directory, not Config or candidate snapshots', async () => {
    const history = await announce(ctx);
    cd(child);
    const [undelivered] = await getEnvironmentAttachments(ctx, history);
    expect(undelivered.changes).toEqual([
      { field: 'workingDirectory', from: root },
    ]);
    cd(other);
    const [delivered] = await getEnvironmentAttachments(ctx, history);
    expect(delivered.changes).toEqual([
      { field: 'workingDirectory', from: root },
    ]);
    expect(delivered.snapshot.workingDirectory).toBe(other);
    expect(delivered.snapshot.additionalWorkingDirectories).toEqual([]);
    expect(ctx.cwd).toBe(root);
    expect(ctx.config!.getWorkingDir()).toBe(root);
    expect(userText(delivered.toUserMessages()[0])).toBe(
      `<system-reminder>\n# Environment update\n- Primary working directory: ${other} (was ${root})\n</system-reminder>`,
    );
    history.push(createAttachmentMessage(delivered));
    expect(await announce(ctx, history)).toEqual([]);
    cd(root);
    expect((await getEnvironmentAttachments(ctx, history))[0].changes).toEqual([
      { field: 'workingDirectory', from: other },
    ]);
  });

  it('does not announce a transient directory change that returned before the next request', async () => {
    const history = await announce(ctx);
    cd(child);
    cd(root);
    expect(await announce(ctx, history)).toEqual([]);
  });

  it('restores the baseline from serialized history for resume and rewind', async () => {
    const history = await announce(ctx);
    cd(child);
    const delta = await announce(ctx, history);
    const saved: Message[] = JSON.parse(JSON.stringify([...history, ...delta]));
    const restored = createAttachmentContext(root);
    restored.config = ctx.config;
    restoreAttachmentTranscriptState(restored, saved);
    expect(await announce(restored, saved)).toEqual([]);
    expect(
      (await getEnvironmentAttachments(restored, history))[0].changes,
    ).toEqual([{ field: 'workingDirectory', from: root }]);
    expect(normalizeMessagesForAPI(saved)).toEqual(
      normalizeMessagesForAPI([...history, ...delta]),
    );
  });

  it('reannounces the full environment when compaction removes the baseline, even if a delta survives', async () => {
    const history = await announce(ctx);
    cd(child);
    const delta = await announce(ctx, history);
    for (const compacted of [[], delta]) {
      const [full] = await getEnvironmentAttachments(ctx, compacted);
      expect(full.changes).toBeUndefined();
      expect(full.snapshot.workingDirectory).toBe(child);
      expect(userText(full.toUserMessages()[0])).toContain('# Environment\n');
    }
  });

  it('reports Git/worktree transitions and additional directory additions/removals as sets', async () => {
    const history = await announce(ctx);
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
      isWorktree: true,
    } as NonNullable<Awaited<ReturnType<typeof resolveGitRepositoryLayout>>>);
    vi.mocked(findGitRootAsync).mockResolvedValue(child);
    cd(child);
    workspace.addDirectories([child, other]);
    const [entered] = await getEnvironmentAttachments(ctx, history);
    expect(entered.changes).toEqual([
      { field: 'workingDirectory', from: root },
      { field: 'isWorktree' },
      { field: 'isGitRepo' },
      {
        field: 'additionalWorkingDirectories',
        added: [child, other],
        removed: [],
      },
    ]);
    expect(userText(entered.toUserMessages()[0])).toContain(
      'This is a git worktree',
    );
    history.push(createAttachmentMessage(entered));
    workspace.setDirectories([other, root, child]);
    expect(await announce(ctx, history)).toEqual([]);
    workspace.setDirectories([root, other]);
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);
    vi.mocked(findGitRootAsync).mockResolvedValue(null);
    cd(other);
    const [left] = await getEnvironmentAttachments(ctx, history);
    expect(left.changes).toEqual([
      { field: 'workingDirectory', from: child },
      { field: 'isWorktree' },
      { field: 'isGitRepo' },
      { field: 'additionalWorkingDirectories', added: [], removed: [child] },
    ]);
    const text = userText(left.toUserMessages()[0]);
    expect(text).toContain('no longer a git worktree');
    expect(text).toContain('Is a git repository: false (was true)');
    expect(text).toContain('Additional working directories removed:');
  });

  it('sends a full environment when the shell changes', async () => {
    vi.stubEnv('SHELL', '/bin/bash');
    const history = await announce(ctx);
    vi.stubEnv('SHELL', '/bin/zsh');
    const [full] = await getEnvironmentAttachments(ctx, history);
    expect(full.changes).toBeUndefined();
    expect(full.snapshot.shell).toBe('/bin/zsh');
  });

  it('isolates sessions and compares a fork against its inherited announcements', async () => {
    const history = await announce(ctx);
    const second = createAttachmentContext(other);
    second.config = {
      getTargetDir: () => other,
      getWorkspaceContext: () => new WorkspaceContext(other),
    } as unknown as Config;
    initializeShellSession(second.config, other);
    const secondHistory = await announce(second);
    cd(child);
    expect(await announce(second, secondHistory)).toEqual([]);
    const fork = createAttachmentContext(other, 'fork', { isMainAgent: false });
    fork.config = ctx.config;
    const [delta] = await runWithCwdOverride(other, () =>
      getEnvironmentAttachments(fork, history),
    );
    expect(delta.snapshot.workingDirectory).toBe(other);
    expect(delta.changes).toEqual([{ field: 'workingDirectory', from: root }]);
    expect(runWithShellSession(ctx.config!, getCwd)).toBe(child);
  });

  it.each(['malformed snapshot', 'empty delta'])(
    'ignores %s during projection and establishes a fresh baseline',
    async (kind) => {
      const history = await announce(ctx);
      const invalid = JSON.parse(JSON.stringify(history[0]));
      if (kind === 'malformed snapshot') {
        invalid.attachment.snapshot.additionalWorkingDirectories = null;
      } else {
        invalid.attachment.changes = [];
      }
      expect(normalizeMessagesForAPI([invalid])).toEqual([]);
      const [full] = await getEnvironmentAttachments(ctx, [
        ...history,
        invalid,
      ]);
      expect(full.changes).toBeUndefined();
      expect(full.snapshot.workingDirectory).toBe(root);
    },
  );

  it('uses the unified human-turn and tool-continuation pipeline without changing Shell cwd', async () => {
    const initial = await getAttachmentMessages(
      'start',
      ctx,
      [],
      null,
      { skipSkillDiscovery: true },
      undefined,
      undefined,
      [],
    );
    expect(
      initial.filter((message) => message.attachment.type === 'environment'),
    ).toHaveLength(1);
    cd(child);
    const delta = await getAttachmentMessages(
      null,
      ctx,
      [],
      null,
      { skipSkillDiscovery: true },
      undefined,
      undefined,
      initial,
    );
    expect(delta).toHaveLength(1);
    expect(delta[0].attachment.type).toBe('environment');
    const projected = normalizeMessagesForAPI([...initial, ...delta]);
    expect(JSON.stringify(projected)).toContain(
      JSON.stringify(`Primary working directory: ${child} (was ${root})`).slice(
        1,
        -1,
      ),
    );
    expect(runWithShellSession(ctx.config!, getCwd)).toBe(child);
    expect(
      await getAttachmentMessages(
        null,
        ctx,
        [],
        null,
        { skipSkillDiscovery: true },
        undefined,
        undefined,
        [...initial, ...delta],
      ),
    ).toEqual([]);
  });
});
