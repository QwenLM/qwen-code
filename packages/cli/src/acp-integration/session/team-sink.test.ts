/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import {
  TeamEventType,
  type TeammateApprovalRequestEvent,
} from '@qwen-code/qwen-code-core/agents/team/team-events.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ToolEditConfirmationDetails } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { attachTeamSink, type TeamSinkDeps } from './team-sink.js';

type LeaderCallback = (
  modelText: string,
  displayText: string,
  senders?: readonly string[],
) => void;

class FakeTeamEmitter {
  private readonly handlers = new Map<string, Set<(e: never) => void>>();

  on(type: string, fn: (e: never) => void): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(fn);
    this.handlers.set(type, set);
  }

  off(type: string, fn: (e: never) => void): void {
    this.handlers.get(type)?.delete(fn);
  }

  emit(type: string, payload: unknown): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      (fn as (e: unknown) => void)(payload);
    }
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

function makeManager() {
  const emitter = new FakeTeamEmitter();
  const manager = {
    leaderCallback: null as LeaderCallback | null,
    setLeaderMessageCallback(cb: LeaderCallback | null) {
      manager.leaderCallback = cb;
    },
    getEventEmitter: () => emitter,
    emitter,
  };
  return manager;
}

function makeConfig(
  manager: ReturnType<typeof makeManager> | null,
  approvalMode = ApprovalMode.DEFAULT,
) {
  const subs = new Set<(m: unknown) => void>();
  return {
    subs,
    onTeamManagerChange(
      cb: ((m: unknown) => void) | null,
      previous?: (m: unknown) => void,
    ) {
      if (previous) subs.delete(previous);
      if (cb) subs.add(cb);
    },
    getTeamManager: () => manager,
    getApprovalMode: () => approvalMode,
    fireChange(next: unknown) {
      for (const sub of [...subs]) sub(next);
    },
  };
}

function editConfirmation(): Omit<ToolEditConfirmationDetails, 'onConfirm'> {
  return {
    type: 'edit',
    title: 'Edit file',
    fileName: '/test.ts',
    filePath: '/test.ts',
    fileDiff: '',
    originalContent: 'old',
    newContent: 'new',
  };
}

function approvalEvent(overrides: Partial<TeammateApprovalRequestEvent> = {}): {
  event: TeammateApprovalRequestEvent;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn(async () => {});
  return {
    respond,
    event: {
      teammateName: 'security',
      toolName: 'write_file',
      toolInput: { path: '/test.ts' },
      confirmationDetails: editConfirmation(),
      timestamp: 1,
      respond,
      ...overrides,
    } as TeammateApprovalRequestEvent,
  };
}

describe('attachTeamSink', () => {
  let manager: ReturnType<typeof makeManager>;
  let config: ReturnType<typeof makeConfig>;
  let injectLeaderMessage: ReturnType<typeof vi.fn>;
  let requestPermission: ReturnType<typeof vi.fn>;
  let reportRosterChange: ReturnType<typeof vi.fn>;
  let reportTeammateActivity: ReturnType<typeof vi.fn>;
  let deps: TeamSinkDeps;

  beforeEach(() => {
    manager = makeManager();
    config = makeConfig(manager);
    injectLeaderMessage = vi.fn();
    requestPermission = vi.fn();
    reportRosterChange = vi.fn();
    reportTeammateActivity = vi.fn();
    deps = {
      config: config as unknown as Config,
      sessionId: 's1',
      signal: new AbortController().signal,
      injectLeaderMessage,
      reportRosterChange,
      reportTeammateActivity,
      requestPermission,
    };
  });

  it('delivers a teammate report to the leader, which no sink ever did on this host', async () => {
    attachTeamSink(deps);
    // The subscription alone is not enough: a manager set before the sink
    // attached must be adopted too.
    expect(manager.leaderCallback).not.toBeNull();

    manager.leaderCallback?.('model text from security', '[team] security', [
      'correctness',
    ]);

    expect(injectLeaderMessage).toHaveBeenCalledWith(
      'model text from security',
      '[team] security',
      ['correctness'],
    );
  });

  it('adopts a manager created after the sink attached', () => {
    const empty = makeConfig(null);
    attachTeamSink({ ...deps, config: empty as unknown as Config });

    const late = makeManager();
    expect(late.leaderCallback).toBeNull();

    // `team_create` installs the manager mid-session, so the change callback is
    // the only path that can pick it up.
    empty.fireChange(late);

    expect(late.leaderCallback).not.toBeNull();
    late.leaderCallback?.('report', '[team] report', ['correctness']);
    expect(injectLeaderMessage).toHaveBeenCalledWith(
      'report',
      '[team] report',
      ['correctness'],
    );
  });

  it('routes a teammate approval to the client and answers with its outcome', async () => {
    attachTeamSink(deps);
    let offered: RequestPermissionRequest | undefined;
    requestPermission.mockImplementation(async (params) => {
      offered = params;
      return {
        outcome: {
          outcome: 'selected',
          optionId: params.options[0]!.optionId,
        },
      };
    });

    const { event, respond } = approvalEvent();
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, event);

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(offered?.toolCall.title).toContain('security');
    expect(offered?.toolCall._meta).toMatchObject({
      toolName: 'write_file',
      teammateName: 'security',
    });
    expect(respond.mock.calls[0]![0]).toBe(offered!.options[0]!.optionId);
  });

  it('fails closed and tells the leader when the host cannot answer', async () => {
    attachTeamSink(deps);
    requestPermission.mockRejectedValue(new Error('client gone'));

    const { event, respond } = approvalEvent();
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, event);

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0]![0]).toBe(ToolConfirmationOutcome.Cancel);
    // Without this the leader only sees a teammate that silently gave up.
    expect(injectLeaderMessage).toHaveBeenCalledWith(
      expect.stringContaining('<team_notice>'),
      expect.stringContaining('[team]'),
    );
  });

  it('auto-approves under YOLO when the request carries no renderable details', async () => {
    const yolo = makeConfig(manager, ApprovalMode.YOLO);
    attachTeamSink({ ...deps, config: yolo as unknown as Config });

    const { event, respond } = approvalEvent({
      confirmationDetails: undefined,
    });
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, event);

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0]![0]).toBe(ToolConfirmationOutcome.ProceedOnce);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('cancels rather than proceeding unreviewed outside YOLO when details are missing', async () => {
    attachTeamSink(deps);

    const { event, respond } = approvalEvent({
      confirmationDetails: undefined,
    });
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, event);

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0]![0]).toBe(ToolConfirmationOutcome.Cancel);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('retracts its own callback and listener on detach', () => {
    const detach = attachTeamSink(deps);
    expect(
      manager.emitter.listenerCount(TeamEventType.TEAMMATE_APPROVAL_REQUEST),
    ).toBe(1);

    detach();

    expect(manager.leaderCallback).toBeNull();
    expect(
      manager.emitter.listenerCount(TeamEventType.TEAMMATE_APPROVAL_REQUEST),
    ).toBe(0);
    // Idempotent: a second detach must not throw or re-touch the manager.
    detach();
    expect(config.subs.size).toBe(0);
  });

  it('detaches from the previous manager on a team swap', () => {
    const detach = attachTeamSink(deps);
    const next = makeManager();

    config.fireChange(next);

    expect(manager.leaderCallback).toBeNull();
    expect(next.leaderCallback).not.toBeNull();
    detach();
    expect(next.leaderCallback).toBeNull();
  });

  it('reports roster joins and exits, and retracts them on detach', () => {
    const detach = attachTeamSink(deps);

    manager.emitter.emit(TeamEventType.TEAMMATE_JOINED, {
      agentId: 'a1',
      name: 'correctness',
      timestamp: 1,
    });
    manager.emitter.emit(TeamEventType.TEAMMATE_EXITED, {
      agentId: 'a1',
      name: 'correctness',
      status: 'completed',
      timestamp: 2,
    });

    expect(reportRosterChange).toHaveBeenNthCalledWith(1, {
      type: 'joined',
      name: 'correctness',
    });
    expect(reportRosterChange).toHaveBeenNthCalledWith(2, {
      type: 'exited',
      name: 'correctness',
      status: 'completed',
    });

    detach();
    manager.emitter.emit(TeamEventType.TEAMMATE_JOINED, {
      agentId: 'a2',
      name: 'tests',
      timestamp: 3,
    });
    expect(reportRosterChange).toHaveBeenCalledTimes(2);
  });

  it('reports teammate tool activity and inter-teammate messages, and retracts them on detach', () => {
    const detach = attachTeamSink(deps);

    manager.emitter.emit(TeamEventType.TEAMMATE_ACTIVITY, {
      agentId: 'a1',
      name: 'researcher',
      toolName: 'read_file',
      phase: 'call',
      description: 'Read notes.md',
      timestamp: 1,
    });
    manager.emitter.emit(TeamEventType.TEAMMATE_ACTIVITY, {
      agentId: 'a1',
      name: 'researcher',
      toolName: 'read_file',
      phase: 'result',
      success: false,
      description: 'file not found',
      timestamp: 2,
    });
    manager.emitter.emit(TeamEventType.MESSAGE_SENT, {
      from: 'writer',
      to: 'checker',
      message: 'sky sentence',
      timestamp: 3,
    });

    expect(reportTeammateActivity).toHaveBeenNthCalledWith(1, {
      kind: 'tool',
      name: 'researcher',
      toolName: 'read_file',
      phase: 'call',
      success: undefined,
      description: 'Read notes.md',
    });
    expect(reportTeammateActivity).toHaveBeenNthCalledWith(2, {
      kind: 'tool',
      name: 'researcher',
      toolName: 'read_file',
      phase: 'result',
      success: false,
      description: 'file not found',
    });
    expect(reportTeammateActivity).toHaveBeenNthCalledWith(3, {
      kind: 'message',
      name: 'writer',
      from: 'writer',
      to: 'checker',
      message: 'sky sentence',
    });

    detach();
    manager.emitter.emit(TeamEventType.TEAMMATE_ACTIVITY, {
      agentId: 'a1',
      name: 'researcher',
      toolName: 'read_file',
      phase: 'call',
      description: 'Read notes.md',
      timestamp: 4,
    });
    manager.emitter.emit(TeamEventType.MESSAGE_SENT, {
      from: 'writer',
      to: 'checker',
      message: 'again',
      timestamp: 5,
    });
    expect(reportTeammateActivity).toHaveBeenCalledTimes(3);
  });
});
