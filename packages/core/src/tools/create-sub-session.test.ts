/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CreateSubSessionTool,
  MAX_SUB_SESSION_PROMPT_CHARS,
} from './create-sub-session.js';
import { ToolConfirmationOutcome } from './tools.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import type {
  Config,
  SubSessionSpawner,
  SubSessionWorkspaceBinding,
} from '../config/config.js';

function makeConfig(
  spawner?: SubSessionSpawner,
  approvalMode = ApprovalMode.DEFAULT,
  sameWorkspace = false,
): Config {
  return {
    getApprovalMode: () => approvalMode,
    getSubSessionSpawner: () => spawner,
    getSubSessionWorkspaceResolver: () => async () => ({
      workspaceId: 'repo-b',
      workspaceCwd: '/canonical/other repo',
      workspaceGeneration: 'generation-b',
      sameWorkspace,
    }),
  } as unknown as Config;
}

describe('CreateSubSessionTool', () => {
  it('has the correct name', () => {
    expect(new CreateSubSessionTool(makeConfig()).name).toBe(
      'create_sub_session',
    );
  });

  it('rejects an unsafe model id at validation, matching the daemon boundary', () => {
    const tool = new CreateSubSessionTool(makeConfig());
    expect(() =>
      tool.build({ prompt: 'do X', model: 'm'.repeat(257) }),
    ).toThrow(/at most 256 characters/);
    expect(() => tool.build({ prompt: 'do X', model: 'bad\nmodel' })).toThrow(
      /control characters/,
    );
  });

  it('passes a target workspace to the spawner and names it for the approver', async () => {
    const spawner = vi.fn(async () => ({
      sessionId: 'sub-1',
      result: 'ok',
      workspaceCwd: '/canonical/other repo',
    }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const invocation = tool.build({ prompt: 'do X', workspace: '/repos/b' });
    const signal = new AbortController().signal;
    const confirmation = await invocation.getConfirmationDetails(signal);
    expect(invocation.getDescription()).toBe(
      '[first-turn] in "/canonical/other repo": do X',
    );
    expect((await invocation.execute(signal)).error?.message).toContain(
      'requires one-time approval',
    );
    expect(spawner).not.toHaveBeenCalled();
    await confirmation!.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect(
      tool.toAutoClassifierInput({ prompt: 'do X', workspace: '/repos/b' }),
    ).toMatchObject({ workspace: '/repos/b' });
    const res = await invocation.execute(new AbortController().signal);
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
      workspace: '/repos/b',
      workspaceGeneration: 'generation-b',
    });
    expect((await invocation.execute(signal)).error?.message).toContain(
      'requires one-time approval',
    );
    expect(spawner).toHaveBeenCalledOnce();
    expect(res.returnDisplay).toContain(
      'qwen-session://sub-1?workspace=%2Fcanonical%2Fother+repo)',
    );
  });

  it('requires one-shot approval only for an explicit workspace', async () => {
    const tool = new CreateSubSessionTool(makeConfig());
    const signal = new AbortController().signal;
    const remote = tool.build({ prompt: 'do X', workspace: '/repos/b' });
    const local = tool.build({ prompt: 'do X' });

    expect(remote.requiresUserInteraction?.()).toBe(true);
    expect(await remote.getConfirmationDetails(signal)).toMatchObject({
      type: 'exec',
      title: '[first-turn] in "/canonical/other repo": do X',
      command: 'do X',
      hideAlwaysAllow: true,
      permissionRules: [],
    });
    expect(await remote.getDefaultPermission()).toBe('ask');
    expect(local.requiresUserInteraction?.()).toBe(false);
    expect(await local.getConfirmationDetails(signal)).toMatchObject({
      type: 'info',
    });
  });

  it.each([
    ApprovalMode.DEFAULT,
    ApprovalMode.AUTO_EDIT,
    ApprovalMode.AUTO,
    ApprovalMode.YOLO,
  ])(
    'treats an explicit current workspace like an omitted one in %s mode',
    async (approvalMode) => {
      const spawner = vi.fn(async () => ({
        sessionId: 'sub-1',
        result: 'current result',
      }));
      const invocation = new CreateSubSessionTool(
        makeConfig(spawner, approvalMode, true),
      ).build({ prompt: 'do X', workspace: '/repos/a' });
      await invocation.getDefaultPermission();
      expect(invocation.requiresUserInteraction?.()).toBe(false);
      await expect(
        invocation.getConfirmationDetails(new AbortController().signal),
      ).resolves.toMatchObject({ type: 'info' });
      await expect(
        invocation.execute(new AbortController().signal),
      ).resolves.toMatchObject({
        llmContent: expect.stringContaining('current result'),
      });
      expect(spawner).toHaveBeenCalledWith({
        prompt: 'do X',
        completion: 'first-turn',
        workspace: '/repos/a',
        workspaceGeneration: 'generation-b',
        ...(approvalMode === ApprovalMode.YOLO ? { requiresYolo: true } : {}),
      });
    },
  );

  it('re-evaluates a resolved workspace ask without re-resolving', async () => {
    const permissions = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => ['create_sub_session(workspace:repo-a)'],
      getPermissionsDeny: () => [],
      getApprovalMode: () => ApprovalMode.DEFAULT,
    });
    permissions.initialize();
    const config = makeConfig();
    config.getPermissionManager = () => permissions;
    const resolveWorkspace = vi.fn().mockResolvedValue({
      workspaceId: 'repo-a',
      workspaceCwd: '/canonical/current repo',
      workspaceGeneration: 'generation-a',
      sameWorkspace: true,
    });
    config.getSubSessionWorkspaceResolver = () => resolveWorkspace;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/a',
    });

    await invocation.getDefaultPermission();
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    await invocation.getDefaultPermission();
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    permissions.removePersistentRule(
      'create_sub_session(workspace:repo-a)',
      'ask',
    );
    await invocation.getDefaultPermission();
    expect(invocation.requiresUserInteraction?.()).toBe(false);
    permissions.addPersistentRule(
      'create_sub_session(workspace:repo-a)',
      'ask',
    );
    await invocation.getDefaultPermission();
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    expect(resolveWorkspace).toHaveBeenCalledTimes(1);
  });

  it('requires AUTO review only for a named remote workspace', async () => {
    const tool = new CreateSubSessionTool(
      makeConfig(undefined, ApprovalMode.AUTO),
    );
    const remote = tool.build({ prompt: 'do X', workspace: '/repos/b' });
    await remote.getDefaultPermission();
    expect(remote.requiresAutoReviewOnAllow?.()).toBe(true);

    const current = new CreateSubSessionTool(
      makeConfig(undefined, ApprovalMode.AUTO, true),
    ).build({ prompt: 'do X', workspace: '/repos/a' });
    await current.getDefaultPermission();
    expect(current.requiresAutoReviewOnAllow?.()).toBe(false);
    expect(tool.build({ prompt: 'do X' }).requiresAutoReviewOnAllow?.()).toBe(
      false,
    );
  });

  it('marks a remote automatic AUTO approval for daemon revalidation', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const invocation = new CreateSubSessionTool(
      makeConfig(spawner, ApprovalMode.AUTO),
    ).build({ prompt: 'do X', workspace: '/repos/b' });
    await invocation.getDefaultPermission();
    await invocation.execute(new AbortController().signal);
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
      workspace: '/repos/b',
      workspaceGeneration: 'generation-b',
      requiresAutoMode: true,
    });
  });

  it('keeps the launcher YOLO guard for an automatic callback approval', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const invocation = new CreateSubSessionTool(
      makeConfig(spawner, ApprovalMode.YOLO),
    ).build({ prompt: 'do X', workspace: '/repos/b' });
    await invocation.getDefaultPermission();
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    expect(confirmation.onAutoConfirm).toBeDefined();
    await confirmation.onAutoConfirm!(ApprovalMode.YOLO);
    await invocation.execute(new AbortController().signal);
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
      workspace: '/repos/b',
      workspaceGeneration: 'generation-b',
      requiresYolo: true,
    });
  });

  it('keeps an explicitly named current workspace blocked in Plan mode', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const invocation = new CreateSubSessionTool(
      makeConfig(spawner, ApprovalMode.PLAN, true),
    ).build({ prompt: 'do X', workspace: '/repos/a' });
    await invocation.getDefaultPermission();
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    await expect(
      invocation.getConfirmationDetails(new AbortController().signal),
    ).resolves.toMatchObject({ type: 'exec' });
    await expect(
      invocation.execute(new AbortController().signal),
    ).resolves.toMatchObject({
      error: { message: expect.stringContaining('one-time approval') },
    });
    expect(spawner).not.toHaveBeenCalled();
  });

  it('keeps the omitted-selector ordinary flow in Plan mode', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const invocation = new CreateSubSessionTool(
      makeConfig(spawner, ApprovalMode.PLAN, true),
    ).build({ prompt: 'do X' });
    await invocation.getDefaultPermission();
    expect(invocation.requiresUserInteraction?.()).toBe(false);
    await expect(
      invocation.getConfirmationDetails(new AbortController().signal),
    ).resolves.toMatchObject({ type: 'info' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
    });
  });

  it('does not start workspace resolution for an already-cancelled call', async () => {
    const config = makeConfig();
    const resolveWorkspace = vi.fn();
    config.getSubSessionWorkspaceResolver = () => resolveWorkspace;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/b',
    });
    const controller = new AbortController();
    controller.abort('stop');
    await expect(
      invocation.getDefaultPermission(controller.signal),
    ).rejects.toThrow('stop');
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it('runs a named workspace without a prompt in YOLO mode', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1', result: 'ok' }));
    let mode = ApprovalMode.YOLO;
    const config = makeConfig(spawner);
    config.getApprovalMode = () => mode;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/b',
    });

    expect(invocation.requiresUserInteraction?.()).toBe(false);
    expect((await invocation.execute(new AbortController().signal)).error).toBe(
      undefined,
    );
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
      workspace: '/repos/b',
      workspaceGeneration: 'generation-b',
      requiresYolo: true,
    });

    // Leaving YOLO before the call runs brings the approval back.
    mode = ApprovalMode.AUTO_EDIT;
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    expect(
      (await invocation.execute(new AbortController().signal)).error?.message,
    ).toContain('requires one-time approval');
    expect(spawner).toHaveBeenCalledOnce();
  });

  it('does not treat switching to AUTO after YOLO approval as classifier approval', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const config = makeConfig(spawner, ApprovalMode.YOLO);
    const approvalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
    config.getApprovalMode = approvalMode;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/b',
    });
    await invocation.getDefaultPermission();
    approvalMode.mockReturnValue(ApprovalMode.AUTO);
    await expect(
      invocation.execute(new AbortController().signal),
    ).resolves.toMatchObject({
      error: { message: expect.stringContaining('one-time approval') },
    });
    expect(spawner).not.toHaveBeenCalled();
  });

  it('rejects an automatic approval when the mode changes before execution', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const config = makeConfig(spawner, ApprovalMode.AUTO);
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/b',
    });
    await invocation.getDefaultPermission();
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await confirmation.onAutoConfirm!(ApprovalMode.AUTO);
    config.getApprovalMode = () => ApprovalMode.DEFAULT;

    await expect(
      invocation.execute(new AbortController().signal),
    ).resolves.toMatchObject({
      error: {
        message: 'Approval mode changed before execution. Please retry.',
        type: 'execution_denied',
      },
    });
    expect(spawner).not.toHaveBeenCalled();
  });

  it('lets a human confirmation override an earlier automatic grant', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const config = makeConfig(spawner, ApprovalMode.AUTO);
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/b',
    });
    await invocation.getDefaultPermission();
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await confirmation.onAutoConfirm!(ApprovalMode.AUTO);
    config.getApprovalMode = () => ApprovalMode.DEFAULT;
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);

    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
      workspace: '/repos/b',
      workspaceGeneration: 'generation-b',
    });
  });

  it('supports switching from AUTO to YOLO before execution', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const approvalMode = vi.fn().mockReturnValue(ApprovalMode.AUTO);
    const config = makeConfig(spawner);
    config.getApprovalMode = approvalMode;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/b',
    });
    await invocation.getDefaultPermission();
    approvalMode.mockReturnValue(ApprovalMode.YOLO);
    await expect(
      invocation.execute(new AbortController().signal),
    ).resolves.not.toMatchObject({
      error: { message: expect.stringContaining('one-time approval') },
    });
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
      workspace: '/repos/b',
      workspaceGeneration: 'generation-b',
      requiresYolo: true,
    });
  });

  it('requires approval if YOLO ends while the named workspace resolves', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    let resolveBinding!: (value: SubSessionWorkspaceBinding) => void;
    const binding = new Promise<SubSessionWorkspaceBinding>((resolve) => {
      resolveBinding = resolve;
    });
    const resolveWorkspace = vi.fn(() => binding);
    let mode = ApprovalMode.YOLO;
    const config = makeConfig(spawner);
    config.getApprovalMode = () => mode;
    config.getSubSessionWorkspaceResolver = () => resolveWorkspace;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'summarize',
      workspace: 'repo-b',
    });

    const result = invocation.execute(new AbortController().signal);
    expect(resolveWorkspace).toHaveBeenCalledOnce();
    mode = ApprovalMode.DEFAULT;
    resolveBinding({
      workspaceId: 'repo-b',
      workspaceCwd: '/repos/b',
      workspaceGeneration: 'generation-b',
      sameWorkspace: false,
    });

    expect((await result).error?.message).toContain(
      'requires one-time approval',
    );
    expect(spawner).not.toHaveBeenCalled();
  });

  it('applies destination deny rules in YOLO mode', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const config = makeConfig(spawner, ApprovalMode.YOLO);
    const permissionManager = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => [],
      getApprovalMode: () => ApprovalMode.YOLO,
    });
    permissionManager.initialize();
    permissionManager.addSessionDenyRule(
      'CreateSubSession(workspace:/canonical/other repo)',
    );
    config.getPermissionManager = () => permissionManager;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'summarize',
      workspace: 'repo-b',
    });

    expect(
      (await invocation.execute(new AbortController().signal)).error?.message,
    ).toContain('denied by permission rules');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('honors a destination deny rule added while approval is pending', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const config = makeConfig(spawner);
    const permissionManager = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => [],
      getApprovalMode: () => ApprovalMode.DEFAULT,
    });
    permissionManager.initialize();
    config.getPermissionManager = () => permissionManager;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'summarize',
      workspace: 'repo-b',
    });
    const signal = new AbortController().signal;
    const confirmation = await invocation.getConfirmationDetails(signal);
    permissionManager.addSessionDenyRule(
      'CreateSubSession(workspace:/canonical/other repo)',
    );
    await confirmation!.onConfirm(ToolConfirmationOutcome.ProceedOnce);

    expect((await invocation.execute(signal)).error?.message).toContain(
      'denied by permission rules',
    );
    expect(spawner).not.toHaveBeenCalled();
  });

  it('sends a follow-up to an earlier sub-session and words the result as one', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'kid', result: 'done' }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const invocation = tool.build({
      prompt: 'and now?',
      sessionId: 'kid',
      workspace: '/repos/b',
    });
    const signal = new AbortController().signal;
    const confirmation = await invocation.getConfirmationDetails(signal);
    expect(invocation.getDescription()).toBe(
      '[first-turn] to "kid" in "/canonical/other repo": and now?',
    );
    // The approver sees which session the prompt goes to.
    expect(confirmation).toMatchObject({
      approvalText: expect.stringContaining('Session: "kid"'),
    });
    await confirmation!.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    const res = await invocation.execute(signal);
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'and now?',
      completion: 'first-turn',
      workspace: '/repos/b',
      workspaceGeneration: 'generation-b',
      sessionId: 'kid',
    });
    expect(res.llmContent).toContain('result');
    expect(res.llmContent).not.toContain('first-turn result');
    const sent = await tool
      .build({ prompt: 'p', sessionId: 'kid', completion: 'sent' })
      .execute(new AbortController().signal);
    expect(sent.llmContent).toContain('accepted the prompt into its queue');
    expect(sent.returnDisplay).toMatch(/ queued$/);
    expect(() => tool.build({ prompt: 'p', sessionId: 'a\nb' })).toThrow(
      /sessionId/,
    );
    expect(() =>
      tool.build({ prompt: 'p', sessionId: 'kid', model: 'm1' }),
    ).toThrow(/cannot be combined/);
    expect(() =>
      tool.build({ prompt: 'p', sessionId: 'kid', name: 'n' }),
    ).toThrow(/cannot be combined/);
    spawner.mockRejectedValueOnce(new Error('not yours'));
    const refused = await tool
      .build({ prompt: 'p', sessionId: 'kid' })
      .execute(new AbortController().signal);
    expect(refused.llmContent).toBe(
      'Error sending to sub-session kid: not yours',
    );
  });

  it('rejects an empty or unsafe workspace at validation', () => {
    const tool = new CreateSubSessionTool(makeConfig());
    expect(() => tool.build({ prompt: 'do X', workspace: ' ' })).toThrow(
      /workspace/,
    );
    expect(() => tool.build({ prompt: 'do X', workspace: 'a\nb' })).toThrow(
      /control characters/,
    );
  });

  it('does not label a same-workspace human approval as an automatic YOLO waiver', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-1' }));
    const config = makeConfig(spawner, ApprovalMode.YOLO, true);
    const permissions = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => ['create_sub_session(workspace:repo-b)'],
      getPermissionsDeny: () => [],
      getApprovalMode: () => ApprovalMode.YOLO,
    });
    permissions.initialize();
    config.getPermissionManager = () => permissions;
    const invocation = new CreateSubSessionTool(config).build({
      prompt: 'do X',
      workspace: '/repos/a',
    });
    await invocation.getDefaultPermission();
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    expect(confirmation).toMatchObject({ type: 'info' });
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    await invocation.execute(new AbortController().signal);
    expect(spawner).toHaveBeenCalledWith({
      prompt: 'do X',
      completion: 'first-turn',
      workspace: '/repos/a',
      workspaceGeneration: 'generation-b',
    });
  });

  it('defaults to ask permission so delegated prompts face classifier review', async () => {
    const tool = new CreateSubSessionTool(makeConfig());
    const invocation = tool.build({ prompt: 'do X' });
    expect(await invocation.getDefaultPermission()).toBe('ask');
  });

  it('reports daemon-only when no spawner is wired (interactive / headless)', async () => {
    const tool = new CreateSubSessionTool(makeConfig(undefined));
    const res = await tool
      .build({ prompt: 'do X' })
      .execute(new AbortController().signal);
    expect(res.error?.message).toContain('qwen serve');
    expect(res.returnDisplay).toContain('daemon-only');
  });

  it('first-turn (default): passes trimmed params to the spawner and returns its result', async () => {
    const spawner = vi.fn(async () => ({
      sessionId: 'sub-1',
      result: 'the answer',
      stopReason: 'end_turn',
    }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: '  summarize  ', model: 'm1', name: 'digest' })
      .execute(new AbortController().signal);

    expect(spawner).toHaveBeenCalledWith({
      prompt: 'summarize',
      completion: 'first-turn',
      model: 'm1',
      name: 'digest',
    });
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('the answer');
    expect(res.llmContent).toContain('sub-1');
  });

  it('sent: returns immediately with the session id, not a result', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-2' }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'go', completion: 'sent' })
      .execute(new AbortController().signal);

    expect(spawner).toHaveBeenCalledWith({ prompt: 'go', completion: 'sent' });
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('sub-2');
    expect(res.llmContent).toMatch(/did not wait/i);
    expect(res.returnDisplay).toBe('[sub-2](qwen-session://sub-2) started');
  });

  it('reports a completed-but-empty first turn without an error', async () => {
    const spawner = vi.fn(async () => ({
      sessionId: 'sub-3',
      result: '',
      stopReason: 'end_turn',
    }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'x' })
      .execute(new AbortController().signal);
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('no text output');
  });

  it.each(['', 'partial answer'])(
    'reports a timed-out follow-up with partial output %j',
    async (result) => {
      const spawner = vi.fn(async () => ({
        sessionId: 'sub-3',
        result,
        stopReason: 'timeout',
      }));
      const res = await new CreateSubSessionTool(makeConfig(spawner))
        .build({ prompt: 'summarize', sessionId: 'sub-3' })
        .execute(new AbortController().signal);

      expect(res.returnDisplay).toBe('[sub-3](qwen-session://sub-3) timed out');
      expect(res.llmContent).toBe(
        'Timed out waiting for [sub-3](qwen-session://sub-3). The original prompt may still be queued or running.' +
          (result ? `\n\nPartial output:\n\n${result}` : ''),
      );
    },
  );

  it('first-turn: warns when the parent link is live-only (parentSessionPersisted:false)', async () => {
    // The daemon reported the parent lineage was NOT durably written — surface
    // the degraded link so the caller knows it won't survive a daemon restart.
    const spawner = vi.fn(async () => ({
      sessionId: 'sub-9',
      result: 'the answer',
      stopReason: 'end_turn',
      parentSessionPersisted: false,
    }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'x' })
      .execute(new AbortController().signal);
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('live-only');
    expect(res.llmContent).toContain('will not survive a daemon restart');
  });

  it('sent: warns when the parent link is live-only (parentSessionPersisted:false)', async () => {
    const spawner = vi.fn(async () => ({
      sessionId: 'sub-10',
      parentSessionPersisted: false,
    }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'go', completion: 'sent' })
      .execute(new AbortController().signal);
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('live-only');
    expect(res.llmContent).toContain('will not survive a daemon restart');
  });

  it('does NOT warn about the parent link when it persisted (or is unreported)', async () => {
    // parentSessionPersisted:true → durable link, no warning.
    const persisted = vi.fn(async () => ({
      sessionId: 'sub-11',
      result: 'ok',
      stopReason: 'end_turn',
      parentSessionPersisted: true,
    }));
    const okRes = await new CreateSubSessionTool(makeConfig(persisted))
      .build({ prompt: 'x' })
      .execute(new AbortController().signal);
    expect(okRes.llmContent).not.toContain('live-only');

    // Field absent (no parent, or a non-reporting path) → also no warning.
    const unreported = vi.fn(async () => ({
      sessionId: 'sub-12',
      result: 'ok',
      stopReason: 'end_turn',
    }));
    const unreportedRes = await new CreateSubSessionTool(makeConfig(unreported))
      .build({ prompt: 'x' })
      .execute(new AbortController().signal);
    expect(unreportedRes.llmContent).not.toContain('live-only');
  });

  it('surfaces a spawner error as a tool error', async () => {
    const spawner = vi.fn(async () => {
      throw new Error('spawn boom');
    });
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'x' })
      .execute(new AbortController().signal);
    expect(res.error?.message).toContain('spawn boom');
  });

  it('returns as soon as the turn is cancelled, without waiting for the spawn', async () => {
    // Session.ts awaits execute() without racing the abort, so a tool that
    // ignores its signal pins the caller's tool loop until the daemon's
    // 5-minute first-turn ceiling. This spawner never settles.
    let rejectSpawn!: (err: Error) => void;
    const spawner = vi.fn(
      () =>
        new Promise<{ sessionId: string }>((_, reject) => {
          rejectSpawn = reject;
        }),
    );
    const ac = new AbortController();
    const tool = new CreateSubSessionTool(makeConfig(spawner));

    const settled = tool.build({ prompt: 'x' }).execute(ac.signal);
    ac.abort();
    const res = await settled;

    expect(res.returnDisplay).toBe('Cancelled');
    expect(res.llmContent).toMatch(/cancelled/i);
    // Returned, not thrown: the scheduler must be told the call did not finish.
    expect(res.interruptedBeforeCompletion).toBe(true);
    // The sub-session is NOT cancelled — it has no abort seam — so the tool
    // must say so rather than implying the work was undone.
    expect(res.llmContent).toMatch(/runs independently|not cancelled/i);
    // The abandoned spawn must not raise an unhandled rejection.
    rejectSpawn(new Error('late failure nobody is listening for'));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('never calls the spawner when the signal is already aborted', async () => {
    // The abort must be checked BEFORE the spawn starts. Passing `spawner(…)`
    // as an argument evaluates it first, so a pre-cancelled turn would still
    // create a sub-session on the daemon (and consume its concurrency slot)
    // before reporting itself cancelled.
    const spawner = vi.fn(async () => ({ sessionId: 'sub-should-not-exist' }));
    const ac = new AbortController();
    ac.abort();

    const res = await new CreateSubSessionTool(makeConfig(spawner))
      .build({ prompt: 'x' })
      .execute(ac.signal);

    expect(spawner).not.toHaveBeenCalled();
    expect(res.returnDisplay).toBe('Cancelled');
    // Nothing was created, so the message must not hedge.
    expect(res.llmContent).toMatch(/no sub-session was created/i);
    expect(res.llmContent).not.toMatch(/may already have been created/i);
  });

  it('reports that a cancelled follow-up may already be queued', async () => {
    const spawner: SubSessionSpawner = () => new Promise(() => {});
    const ac = new AbortController();
    const result = new CreateSubSessionTool(makeConfig(spawner))
      .build({ prompt: 'x', sessionId: 'kid' })
      .execute(ac.signal);
    ac.abort();

    await expect(result).resolves.toMatchObject({
      llmContent: expect.stringContaining(
        'follow-up prompt may already be queued',
      ),
      interruptedBeforeCompletion: true,
    });
  });

  it('does not report cancellation when the spawn wins the race', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-7', result: 'done' }));
    const ac = new AbortController();
    const res = await new CreateSubSessionTool(makeConfig(spawner))
      .build({ prompt: 'x' })
      .execute(ac.signal);
    expect(res.returnDisplay).not.toBe('Cancelled');
    expect(res.llmContent).toContain('done');
  });

  it('rejects a prompt over the character limit before reaching the spawner', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-8' }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    expect(() =>
      tool.build({ prompt: 'x'.repeat(MAX_SUB_SESSION_PROMPT_CHARS + 1) }),
    ).toThrow(new RegExp(`${MAX_SUB_SESSION_PROMPT_CHARS}`));
    expect(spawner).not.toHaveBeenCalled();
    // The boundary itself is accepted.
    expect(() =>
      tool.build({ prompt: 'x'.repeat(MAX_SUB_SESSION_PROMPT_CHARS) }),
    ).not.toThrow();
  });
});
