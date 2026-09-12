// @vitest-environment jsdom
import { act } from 'react';
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

function mount() {
  const command = deferred<{ stopReason: 'end_turn' | 'cancelled' }>();
  const read = deferred<DaemonSessionContextUsageStatus>();
  const onBeforeCompress = vi.fn();
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
  const ownerGuard = {
    capture: () => {
      const captured = generation;
      return { isCurrent: () => generation === captured };
    },
  };
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
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = () => act(() => root.render(<Probe />));
  render();
  return {
    command,
    read,
    sendPrompt,
    getContextUsage,
    onBeforeCompress,
    get controls() {
      return latest!;
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

  it.each([
    { status: 'disconnected' as const },
    { status: 'error' as const },
    { loadingTranscript: true },
    { catchingUp: true },
    { goalState: undefined },
    { commands: [] },
    {
      commands: [
        { name: 'compress', description: '', source: 'custom-command' },
      ],
    },
  ])(
    'rejects a stale callback after availability changes: %j',
    async (patch) => {
      const h = mount();
      const old = h.controls.compress;
      h.update(patch as Partial<DaemonConnectionState>);
      expect(h.controls.canCompress).toBe(false);
      await act(async () => old());
      expect(h.sendPrompt).not.toHaveBeenCalled();
      expect(h.onBeforeCompress).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, false],
    [false, true],
  ])(
    'blocks active work or a pending write (busy=%s, blocked=%s)',
    async (busy, blocked) => {
      const h = mount();
      const old = h.controls.compress;
      h.update({}, busy, blocked);
      await act(async () => old());
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
