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
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { attachTeamSink, type TeamSinkDeps } from './team-sink.js';

type LeaderCallback = (
  modelText: string,
  displayText: string,
  senders?: readonly string[],
) => void;

class FakeTeamEmitter {
  // A list, not a Set: TeamEventEmitter wraps a real Node EventEmitter, which
  // accepts the same listener twice. A Set silently dedupes the sink's stable
  // closures and makes every listener-count assertion below unfalsifiable.
  private readonly handlers = new Map<string, Array<(e: never) => void>>();

  on(type: string, fn: (e: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  off(type: string, fn: (e: never) => void): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
  }

  emit(type: string, payload: unknown): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      (fn as (e: unknown) => void)(payload);
    }
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.length ?? 0;
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
  let retireTeamBinding: ReturnType<typeof vi.fn>;
  let retireTeammateApprovals: ReturnType<typeof vi.fn>;
  let deps: TeamSinkDeps;

  // Re-fires the team-manager change callback with the already-bound manager,
  // mirroring Config.setTeamManager's unconditional callback invocation.
  const handleSameManagerNotify = (): void => {
    config.fireChange(manager);
  };

  beforeEach(() => {
    manager = makeManager();
    config = makeConfig(manager);
    injectLeaderMessage = vi.fn();
    requestPermission = vi.fn();
    reportRosterChange = vi.fn();
    retireTeamBinding = vi.fn(async () => {});
    retireTeammateApprovals = vi.fn(async () => {});
    deps = {
      config: config as unknown as Config,
      sessionId: 's1',
      signal: new AbortController().signal,
      injectLeaderMessage,
      reportRosterChange,
      retireTeamBinding,
      retireTeammateApprovals,
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
    expect(offered?._meta).toEqual({
      permissionScope: 'session',
      teammateBindingId: expect.any(Number),
    });
    expect(offered?.toolCall.title).toContain('security');
    expect(offered?.toolCall._meta).toMatchObject({
      toolName: 'write_file',
      teammateName: 'security',
    });
    expect(respond.mock.calls[0]![0]).toBe(offered!.options[0]!.optionId);
  });

  it('does not report a host failure when the abort rejects the request', async () => {
    // The real collaborator rejects with an abort-shaped error when the signal
    // fires (`requestPermissionWithAbort`), so the rejection must be swallowed
    // by the abort guard instead of reaching the fail-closed branch, which
    // would answer a second time and tell the leader the host stayed silent.
    requestPermission.mockImplementation(
      (_params: RequestPermissionRequest, signal: AbortSignal) =>
        new Promise<RequestPermissionResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new Error('Permission request was aborted.')),
          );
        }),
    );
    const detach = attachTeamSink(deps);
    const { event, respond } = approvalEvent();
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, event);

    detach();

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0]![0]).toBe(ToolConfirmationOutcome.Cancel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(deps.injectLeaderMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('could not answer'),
      expect.anything(),
    );
  });

  it('cancels without a leader notice when the answer names a stripped option', async () => {
    // A direct ACP client can answer with an option the policy filter removed.
    // The host did answer, so the fail-closed leader notice would be false; the
    // tool still must not proceed unreviewed.
    requestPermission.mockResolvedValue({
      outcome: {
        outcome: 'selected',
        optionId: 'proceed_always_project_NOT_OFFERED',
      },
    } as RequestPermissionResponse);
    const detach = attachTeamSink(deps);
    const { event, respond } = approvalEvent();
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, event);

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0]![0]).toBe(ToolConfirmationOutcome.Cancel);
    expect(deps.injectLeaderMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('could not answer'),
      expect.anything(),
    );
    detach();
  });

  it('keeps simultaneous approvals from the same teammate independently addressable', async () => {
    const detach = attachTeamSink(deps);
    const pending = new Map<
      string,
      (response: RequestPermissionResponse) => void
    >();
    const requests: RequestPermissionRequest[] = [];
    requestPermission.mockImplementation((params: RequestPermissionRequest) => {
      requests.push(params);
      return new Promise<RequestPermissionResponse>((resolve) => {
        pending.set(params.toolCall.toolCallId, resolve);
      });
    });
    const first = approvalEvent({ toolInput: { path: '/first.ts' } });
    const second = approvalEvent({ toolInput: { path: '/second.ts' } });
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, first.event);
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, second.event);

    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(pending.size).toBe(2);
    expect(requests[0]!.toolCall.rawInput).toEqual(first.event.toolInput);
    expect(requests[1]!.toolCall.rawInput).toEqual(second.event.toolInput);

    pending.get(requests[1]!.toolCall.toolCallId)!({
      outcome: { outcome: 'cancelled' },
    });
    await vi.waitFor(() => expect(second.respond).toHaveBeenCalledTimes(1));
    expect(second.respond.mock.calls[0]![0]).toBe(
      ToolConfirmationOutcome.Cancel,
    );
    expect(first.respond).not.toHaveBeenCalled();

    pending.get(requests[0]!.toolCall.toolCallId)!({
      outcome: {
        outcome: 'selected',
        optionId: ToolConfirmationOutcome.ProceedOnce,
      },
    });
    await vi.waitFor(() => expect(first.respond).toHaveBeenCalledTimes(1));
    expect(first.respond.mock.calls[0]![0]).toBe(
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect(second.respond).toHaveBeenCalledTimes(1);

    detach();
    manager.emitter.emit(
      TeamEventType.TEAMMATE_APPROVAL_REQUEST,
      approvalEvent().event,
    );
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it.each(['manager swap', 'detach'] as const)(
    'cancels pending approvals on %s and ignores late host approval',
    async (boundary) => {
      const pending: Array<{
        signal: AbortSignal;
        resolve: (response: RequestPermissionResponse) => void;
      }> = [];
      requestPermission.mockImplementation(
        (_params: RequestPermissionRequest, signal: AbortSignal) =>
          new Promise<RequestPermissionResponse>((resolve) => {
            pending.push({ signal, resolve });
          }),
      );
      const detach = attachTeamSink(deps);
      const old = approvalEvent();
      manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, old.event);

      config.fireChange(manager);
      expect(old.respond).not.toHaveBeenCalled();
      expect(pending[0]!.signal.aborted).toBe(false);
      expect(retireTeamBinding).not.toHaveBeenCalled();
      const oldBindingId =
        requestPermission.mock.calls[0]![0]._meta.teammateBindingId;

      const next = makeManager();
      if (boundary === 'manager swap') config.fireChange(next);
      else detach();

      expect(pending[0]!.signal.aborted).toBe(true);
      expect(retireTeamBinding).toHaveBeenCalledExactlyOnceWith(oldBindingId);
      expect(old.respond).toHaveBeenCalledTimes(1);
      expect(old.respond.mock.calls[0]![0]).toBe(
        ToolConfirmationOutcome.Cancel,
      );

      pending[0]!.resolve({
        outcome: {
          outcome: 'selected',
          optionId: ToolConfirmationOutcome.ProceedOnce,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(old.respond).toHaveBeenCalledTimes(1);

      if (boundary === 'manager swap') {
        const current = approvalEvent();
        next.emitter.emit(
          TeamEventType.TEAMMATE_APPROVAL_REQUEST,
          current.event,
        );
        expect(pending[1]!.signal.aborted).toBe(false);
        expect(
          requestPermission.mock.calls[1]![0]._meta.teammateBindingId,
        ).toBeGreaterThan(oldBindingId);
        pending[1]!.resolve({
          outcome: {
            outcome: 'selected',
            optionId: ToolConfirmationOutcome.ProceedOnce,
          },
        });
        await vi.waitFor(() =>
          expect(current.respond).toHaveBeenCalledTimes(1),
        );
        expect(current.respond.mock.calls[0]![0]).toBe(
          ToolConfirmationOutcome.ProceedOnce,
        );
        detach();
        expect(current.respond).toHaveBeenCalledTimes(1);
      }
    },
  );

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

  it('does not tell the leader the host failed to answer once the host has answered', async () => {
    attachTeamSink(deps);
    let offeredId: string | undefined;
    requestPermission.mockImplementation(
      async (params: RequestPermissionRequest) => {
        offeredId = params.options[0]!.optionId;
        return {
          outcome: { outcome: 'selected', optionId: offeredId },
        };
      },
    );

    // agent-core re-throws a failure from the resumed tool body, so `respond`
    // rejects *after* the user's answer was accepted.
    const respond = vi.fn(async (..._args: unknown[]) => {
      throw new Error('resumed tool body failed');
    });
    const { event } = approvalEvent({ respond });
    manager.emitter.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, event);

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(respond.mock.calls[0]![0]).toBe(offeredId);
    // The host did answer and the tool ran with its outcome, so a second
    // Cancel is a no-op and a "could not answer" notice would be false.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(injectLeaderMessage).not.toHaveBeenCalled();
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

  it('retires the exiting teammate\u2019s approvals on the host', () => {
    // A teammate approval is session-scoped, so nothing about the leader's
    // turn ends it: without this the host keeps advertising a prompt whose
    // requester has left.
    const detach = attachTeamSink(deps);

    manager.emitter.emit(TeamEventType.TEAMMATE_EXITED, {
      agentId: 'a1',
      name: 'correctness',
      status: 'completed',
      timestamp: 1,
    });

    expect(retireTeammateApprovals).toHaveBeenCalledExactlyOnceWith(
      'correctness',
    );

    const rosterReportsBeforeDetach = reportRosterChange.mock.calls.length;
    detach();
    // Every other manager listener is pinned quiet after detach; a leaked exit
    // listener would keep retiring approvals and queueing roster items for a
    // team this session no longer manages.
    expect(manager.emitter.listenerCount('teammate_exited')).toBe(0);
    manager.emitter.emit(TeamEventType.TEAMMATE_EXITED, {
      agentId: 'a2',
      name: 'correctness',
      status: 'completed',
      timestamp: 2,
    });
    expect(retireTeammateApprovals).toHaveBeenCalledTimes(1);
    expect(reportRosterChange.mock.calls.length).toBe(
      rosterReportsBeforeDetach,
    );
  });

  it('ignores a same-instance manager re-notification instead of doubling listeners', () => {
    // Config.setTeamManager fires change callbacks even for the identical
    // manager object; without the identity guard the sink registers a second
    // copy of every listener, so one approval prompts the host twice and
    // detach leaks one copy.
    const detach = attachTeamSink(deps);
    const emitter = manager.emitter;
    expect(emitter.listenerCount('teammate_approval_request')).toBe(1);

    handleSameManagerNotify();

    expect(emitter.listenerCount('teammate_approval_request')).toBe(1);
    expect(emitter.listenerCount('teammate_joined')).toBe(1);
    expect(emitter.listenerCount('teammate_exited')).toBe(1);

    detach();
    expect(emitter.listenerCount('teammate_approval_request')).toBe(0);
  });
});
