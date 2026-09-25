// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonConnectionState,
  DaemonSessionActions,
  DaemonSessionContextUsageStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  useContextUsageControls,
  type ContextUsageControls,
} from './useContextUsageControls';
import { ContextCompressionAnnouncementContext } from '../components/ContextCompressionAnnouncer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => act(() => roots.splice(0).forEach((root) => root.unmount())));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function usage(sessionId = 'session-a'): DaemonSessionContextUsageStatus {
  return {
    v: 1,
    sessionId,
    workspaceCwd: '/workspace',
    formattedText: '',
    usage: {
      modelName: 'test',
      totalTokens: 30,
      contextWindowSize: 100,
      breakdown: {
        systemPrompt: 10,
        builtinTools: 5,
        mcpTools: 0,
        memoryFiles: 0,
        skills: 0,
        messages: 15,
        freeSpace: 60,
        autocompactBuffer: 10,
      },
      builtinTools: [],
      mcpTools: [],
      memoryFiles: [],
      skills: [],
      showDetails: true,
    },
  };
}

function mount({ inheritAnnouncement = false } = {}) {
  const command = deferred<{ stopReason: 'end_turn' | 'cancelled' }>();
  const read = deferred<DaemonSessionContextUsageStatus>();
  const onBeforeCompress = vi.fn();
  const onAnnouncement = vi.fn();
  const inheritedAnnouncement = vi.fn();
  const sendPrompt = vi.fn().mockReturnValue(command.promise);
  const getContextUsage = vi.fn().mockReturnValue(read.promise);
  const actions = {
    sendPrompt,
    getContextUsage,
  } as unknown as DaemonSessionActions;
  let connection: DaemonConnectionState = {
    sessionId: 'session-a',
    workspaceCwd: '/workspace',
    status: 'connected',
    goalState: { v: 2, goal: null, activity: 'idle' },
    commands: [
      { name: 'compress', description: '', source: 'builtin-command' },
    ],
  };
  let generation = 0;
  let recovery = 0;
  const captureOwner = vi.fn((options?: { includeRecovery?: boolean }) => {
    const captured = generation;
    const capturedRecovery = recovery;
    return {
      isCurrent: () =>
        generation === captured &&
        (!options?.includeRecovery || recovery === capturedRecovery),
    };
  });
  const ownerGuard = { capture: captureOwner };
  let busy = false;
  let writeBlocked = false;
  let latest: ContextUsageControls | undefined;
  function Probe() {
    latest = useContextUsageControls({
      connection,
      actions,
      ownerGuard,
      busy,
      writeBlocked,
      onBeforeCompress,
      onAnnouncement: inheritAnnouncement ? undefined : onAnnouncement,
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = () =>
    act(() =>
      root.render(
        <StrictMode>
          <ContextCompressionAnnouncementContext.Provider
            value={inheritAnnouncement ? inheritedAnnouncement : undefined}
          >
            <Probe />
          </ContextCompressionAnnouncementContext.Provider>
        </StrictMode>,
      ),
    );
  render();
  return {
    command,
    read,
    sendPrompt,
    getContextUsage,
    onBeforeCompress,
    onAnnouncement,
    inheritedAnnouncement,
    captureOwner,
    get controls() {
      return latest!;
    },
    recover() {
      recovery++;
      render();
    },
    replaceClient() {
      generation++;
      render();
    },
    update(
      patch: Partial<DaemonConnectionState>,
      active = false,
      blocked = false,
    ) {
      if (
        patch.sessionId !== undefined &&
        patch.sessionId !== connection.sessionId
      )
        generation++;
      connection = { ...connection, ...patch };
      busy = active;
      writeBlocked = blocked;
      render();
    },
    unmount() {
      act(() => root.unmount());
      roots.splice(roots.indexOf(root), 1);
    },
  };
}

describe('useContextUsageControls', () => {
  it('announces each real operation transition once and gives retries a new identity', async () => {
    const h = mount();
    let operation!: Promise<void>;
    act(() => {
      operation = h.controls.compress();
      void h.controls.compress();
    });
    expect(h.onAnnouncement).toHaveBeenCalledExactlyOnceWith({
      operation: expect.any(Object),
      sessionId: 'session-a',
      workspaceCwd: '/workspace',
      phase: 'pending',
    });
    const first = h.onAnnouncement.mock.calls[0][0].operation;
    h.update({});
    expect(h.onAnnouncement).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.command.reject(new Error('failed'));
      await operation;
    });
    expect(h.onAnnouncement.mock.calls[1][0]).toMatchObject({
      operation: first,
      phase: 'failed',
    });
    h.sendPrompt.mockResolvedValueOnce({ stopReason: 'cancelled' });
    await act(async () => h.controls.compress());
    expect(h.onAnnouncement).toHaveBeenCalledTimes(4);
    expect(h.onAnnouncement.mock.calls[2][0].operation).not.toBe(first);
    expect(h.onAnnouncement.mock.calls[3][0]).toMatchObject({
      operation: h.onAnnouncement.mock.calls[2][0].operation,
      phase: 'cancelled',
    });
  });

  it('captures recovery-aware owners for retained counter reconciliation', () => {
    const h = mount();
    const original = h.controls.captureOwner();
    expect(original.isCurrent()).toBe(true);
    h.recover();
    expect(original.isCurrent()).toBe(false);
    expect(h.captureOwner).toHaveBeenLastCalledWith({ includeRecovery: true });
    expect(h.controls.captureOwner().isCurrent()).toBe(true);
    h.update({ sessionId: 'session-b' });
    expect(original.isCurrent()).toBe(false);
    expect(h.controls.captureOwner().isCurrent()).toBe(true);
    h.update({ sessionId: 'session-a' });
    expect(original.isCurrent()).toBe(false);
    expect(h.controls.captureOwner().isCurrent()).toBe(true);
  });

  it.each(['command', 'reading'])(
    'settles compression after same-session recovery during the %s',
    async (phase) => {
      const h = mount();
      let operation!: Promise<void>;
      act(() => {
        operation = h.controls.compress();
      });
      if (phase === 'command') h.recover();
      await act(async () => h.command.resolve({ stopReason: 'end_turn' }));
      if (phase === 'reading') h.recover();
      expect(h.controls.compressing).toBe(true);
      await act(async () => {
        h.read.resolve(usage());
        await operation;
      });
      expect(h.controls.result).toEqual({ kind: 'completed', usage: usage() });
      expect(h.controls.compressing).toBe(false);
    },
  );

  it.each([
    ['command', 'resolve'],
    ['command', 'reject'],
    ['reading', 'resolve'],
    ['reading', 'reject'],
  ] as const)(
    'keeps compression pending across client replacement during the %s, then reports an unknown outcome on %s',
    async (phase, settlement) => {
      const h = mount();
      let operation!: Promise<void>;
      act(() => {
        operation = h.controls.compress();
      });
      if (phase === 'reading') {
        await act(async () => h.command.resolve({ stopReason: 'end_turn' }));
      }
      h.replaceClient();
      expect(h.controls.compressing).toBe(true);
      expect(h.controls.canCompress).toBe(false);
      act(() => void h.controls.compress());
      expect(h.sendPrompt).toHaveBeenCalledOnce();
      await act(async () => {
        if (settlement === 'reject') {
          (phase === 'command' ? h.command : h.read).reject(
            new Error('offline'),
          );
        } else if (phase === 'command') {
          h.command.resolve({ stopReason: 'end_turn' });
        } else h.read.resolve(usage());
        await operation;
      });
      expect(h.controls.compressing).toBe(false);
      expect(h.controls.canCompress).toBe(true);
      expect(h.controls.result).toEqual({ kind: 'interrupted' });
      expect(h.onAnnouncement.mock.calls[1][0]).toMatchObject({
        phase: 'interrupted',
      });
      expect(h.getContextUsage).toHaveBeenCalledTimes(
        phase === 'command' ? 0 : 1,
      );
      h.sendPrompt.mockResolvedValueOnce({ stopReason: 'cancelled' });
      await act(async () => h.controls.compress());
      expect(h.sendPrompt).toHaveBeenCalledTimes(2);
      expect(h.controls.result).toEqual({ kind: 'cancelled' });
    },
  );

  it.each(['sessionId', 'workspaceCwd'] as const)(
    'does not resurrect a pending operation or callback after leaving and returning to %s',
    async (field) => {
      const h = mount();
      const original = h.controls.compress;
      let operation!: Promise<void>;
      act(() => {
        operation = original();
      });
      h.update({ [field]: field === 'sessionId' ? 'session-b' : '/other' });
      h.update({ [field]: field === 'sessionId' ? 'session-a' : '/workspace' });
      expect(h.controls.compressing).toBe(false);
      await act(async () => {
        await original();
        h.command.resolve({ stopReason: 'end_turn' });
        await operation;
      });
      expect(h.sendPrompt).toHaveBeenCalledOnce();
      expect(h.getContextUsage).not.toHaveBeenCalled();
      expect(h.controls.result).toBeUndefined();
    },
  );

  it('waits for completion, submits once, and reads fresh usage through the owner', async () => {
    const h = mount();
    let operation!: Promise<void>;
    act(() => {
      operation = h.controls.compress();
      void h.controls.compress();
    });
    expect(h.onBeforeCompress).toHaveBeenCalledOnce();
    expect(h.onBeforeCompress.mock.invocationCallOrder[0]).toBeLessThan(
      h.sendPrompt.mock.invocationCallOrder[0],
    );
    expect(h.sendPrompt).toHaveBeenCalledExactlyOnceWith('/compress');
    expect(h.getContextUsage).not.toHaveBeenCalled();
    expect(h.controls.compressing).toBe(true);
    expect(h.controls.canCompress).toBe(false);
    await act(async () => h.command.resolve({ stopReason: 'end_turn' }));
    expect(h.getContextUsage).toHaveBeenCalledExactlyOnceWith({
      detail: true,
      silent: true,
      syncCounters: true,
    });
    expect(h.controls.compressing).toBe(true);
    await act(async () => {
      h.read.resolve(usage());
      await operation;
    });
    expect(h.controls.result).toEqual({ kind: 'completed', usage: usage() });
    expect(h.controls.canCompress).toBe(true);
  });

  it('uses the inherited announcement callback when no owner callback is provided', async () => {
    const h = mount({ inheritAnnouncement: true });
    const initialControls = h.controls;
    h.update({});
    expect(h.controls).toBe(initialControls);
    let operation!: Promise<void>;
    act(() => {
      operation = h.controls.compress();
    });
    expect(h.inheritedAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'pending' }),
    );
    await act(async () => {
      h.command.reject(new Error('failed'));
      await operation;
    });
    expect(h.inheritedAnnouncement).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'failed' }),
    );
  });

  it.each([
    { status: 'disconnected' as const },
    { status: 'error' as const },
    { loadingTranscript: true },
    { catchingUp: true },
    { goalState: undefined },
    {
      goalState: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'g1',
          revision: 1,
          objective: 'ship it',
          status: 'active',
          evidenceCursor: { recordId: null },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      },
    },
    { commands: undefined },
    { commands: [] },
    {
      commands: [
        { name: 'compress', description: '', source: 'custom-command' },
      ],
    },
  ])('rejects a stale callback after availability changes: %j', (patch) => {
    const h = mount();
    const old = h.controls.compress;
    h.update(patch as Partial<DaemonConnectionState>);
    expect(h.controls.canCompress).toBe(false);
    act(() => void old());
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.onBeforeCompress).not.toHaveBeenCalled();
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    'blocks active work or a pending write (busy=%s, blocked=%s)',
    (busy, blocked) => {
      const h = mount();
      const old = h.controls.compress;
      h.update({}, busy, blocked);
      act(() => void old());
      expect(h.sendPrompt).not.toHaveBeenCalled();
      expect(h.onBeforeCompress).not.toHaveBeenCalled();
      expect(h.controls.canCompress).toBe(false);
    },
  );

  it('does not run an old session callback against the replacement session', async () => {
    const h = mount();
    const old = h.controls.compress;
    h.update({ sessionId: 'session-b' });
    await act(async () => old());
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.onBeforeCompress).not.toHaveBeenCalled();
  });

  it('rejects the old workspace callback and allows the current one', async () => {
    const h = mount();
    const old = h.controls.compress;
    h.update({ workspaceCwd: '/other' });
    await act(async () => old());
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.onBeforeCompress).not.toHaveBeenCalled();
    act(() => void h.controls.compress());
    expect(h.sendPrompt).toHaveBeenCalledExactlyOnceWith('/compress');
  });

  it('does not submit through a callback after unmount', async () => {
    const h = mount();
    const old = h.controls.compress;
    h.unmount();
    await act(async () => old());
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.onBeforeCompress).not.toHaveBeenCalled();
  });

  it.each(['wrong-session', 'unavailable'] as const)(
    'does not report an invalid reading as completion: %s',
    async (kind) => {
      const h = mount();
      let operation!: Promise<void>;
      act(() => {
        operation = h.controls.compress();
      });
      await act(async () => h.command.resolve({ stopReason: 'end_turn' }));
      const reading = usage(
        kind === 'wrong-session' ? 'session-b' : 'session-a',
      );
      if (kind === 'unavailable') {
        reading.usage.totalTokens = 0;
        reading.usage.contextWindowSize = 0;
      }
      await act(async () => {
        h.read.resolve(reading);
        await operation;
      });
      expect(h.controls.result).toEqual({ kind: 'refreshFailed' });
      expect(h.controls.canCompress).toBe(true);
    },
  );

  it.each(['switch', 'unmount'] as const)(
    'ignores completion after source %s',
    async (change) => {
      const h = mount();
      let operation!: Promise<void>;
      act(() => {
        operation = h.controls.compress();
      });
      if (change === 'switch') h.update({ sessionId: 'session-b' });
      else h.unmount();
      await act(async () => {
        h.command.resolve({ stopReason: 'end_turn' });
        await operation;
      });
      expect(h.getContextUsage).not.toHaveBeenCalled();
      expect(h.onAnnouncement).toHaveBeenCalledTimes(1);
      if (change === 'switch') expect(h.controls.result).toBeUndefined();
    },
  );

  it('does not apply a delayed read to a replacement session', async () => {
    const h = mount();
    let operation!: Promise<void>;
    act(() => {
      operation = h.controls.compress();
    });
    await act(async () => h.command.resolve({ stopReason: 'end_turn' }));
    h.update({ sessionId: 'session-b' });
    await act(async () => {
      h.read.resolve(usage());
      await operation;
    });
    expect(h.controls.result).toBeUndefined();
    expect(h.controls.canCompress).toBe(true);
  });

  it('reports cancellation without claiming success or refreshing', async () => {
    const h = mount();
    let operation!: Promise<void>;
    act(() => {
      operation = h.controls.compress();
    });
    await act(async () => {
      h.command.resolve({ stopReason: 'cancelled' });
      await operation;
    });
    expect(h.controls.result).toEqual({ kind: 'cancelled' });
    expect(h.getContextUsage).not.toHaveBeenCalled();
  });

  it.each(['command', 'read'] as const)(
    'keeps the replacement compression active when a stale %s settles',
    async (stage) => {
      const h = mount();
      let first!: Promise<void>;
      act(() => {
        first = h.controls.compress();
      });
      if (stage === 'read') {
        await act(async () => h.command.resolve({ stopReason: 'end_turn' }));
      }
      h.update({ sessionId: 'session-b' });
      expect(h.controls.canCompress).toBe(true);
      expect(h.controls.compressing).toBe(false);
      expect(h.controls.result).toBeUndefined();
      const nextCommand = deferred<{ stopReason: 'end_turn' }>();
      const nextRead = deferred<DaemonSessionContextUsageStatus>();
      h.sendPrompt.mockReturnValueOnce(nextCommand.promise);
      h.getContextUsage.mockReturnValueOnce(nextRead.promise);
      let second!: Promise<void>;
      act(() => {
        second = h.controls.compress();
      });
      expect(h.sendPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (stage === 'command') h.command.resolve({ stopReason: 'end_turn' });
        else h.read.resolve(usage());
        await first;
      });
      expect(h.controls.compressing).toBe(true);
      expect(h.controls.result).toBeUndefined();
      act(() => void h.controls.compress());
      expect(h.sendPrompt).toHaveBeenCalledTimes(2);
      await act(async () => nextCommand.resolve({ stopReason: 'end_turn' }));
      await act(async () => {
        nextRead.resolve(usage('session-b'));
        await second;
      });
      expect(h.controls.result).toEqual({
        kind: 'completed',
        usage: usage('session-b'),
      });
      h.sendPrompt.mockResolvedValueOnce({ stopReason: 'cancelled' });
      await act(async () => h.controls.compress());
      expect(h.sendPrompt).toHaveBeenCalledTimes(3);
      expect(h.controls.result).toEqual({ kind: 'cancelled' });
    },
  );

  it('distinguishes command failure from post-compression read failure', async () => {
    for (const failRead of [false, true]) {
      const h = mount();
      let operation!: Promise<void>;
      act(() => {
        operation = h.controls.compress();
      });
      await act(async () => {
        if (failRead) {
          h.command.resolve({ stopReason: 'end_turn' });
          await Promise.resolve();
          h.read.reject(new Error('read failed'));
        } else h.command.reject(new Error('compression failed'));
        await operation;
      });
      expect(h.controls.result).toEqual({
        kind: failRead ? 'refreshFailed' : 'failed',
      });
      expect(h.controls.canCompress).toBe(true);
      expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    }
  });
});
