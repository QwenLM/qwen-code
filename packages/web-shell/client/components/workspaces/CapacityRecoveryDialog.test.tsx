// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonClient,
  type DaemonRuntimeStopResult,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  CapacityRecoveryDialog,
  type CapacityRecoveryIntent,
} from './CapacityRecoveryDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
const result: DaemonRuntimeStopResult = {
  channelId: 'child',
  runtimeEpoch: 1,
  stopToken: 'token',
  state: 'stopped',
  stopped: true,
  released: true,
  affectedSessionIds: ['s1'],
  closedSessionIds: ['s1'],
  interruptedSessionIds: ['s1'],
  remainingSessionIds: [],
};
async function mount(
  stop = vi.fn().mockResolvedValue(result),
  language: 'en' | 'zh-CN' = 'en',
) {
  const workspace = {
    workspaceId: 'a',
    cwd: '/a',
    channelId: 'child',
    runtimeEpoch: 1,
    stopToken: 'token',
    canStop: true,
    blockedReasons: [],
    sessions: [{ sessionId: 's1', hasActivePrompt: true, queuedPrompts: 2 }],
    lastStop: undefined as DaemonRuntimeStopResult | undefined,
  };
  const runtimeStopOptions = vi.fn(async () => ({
    committedAcpChildren: 1,
    maxConcurrentChildren: 1,
    workspaces: [workspace],
  }));
  const client = {
    runtimeStopOptions,
    workspaceById: vi.fn(() => ({ stopRuntime: stop })),
  } as unknown as DaemonClient;
  const resume = vi.fn(async () => {});
  const isCurrent = vi.fn(() => true);
  const intent: CapacityRecoveryIntent = {
    client,
    requesterCwd: '/b',
    resume,
    isCurrent,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
        <CapacityRecoveryDialog intent={intent} onClose={onClose} />
      </I18nProvider>,
    );
  });
  return { stop, resume, isCurrent, onClose, workspace, runtimeStopOptions };
}
function button(text: string) {
  return [...document.querySelectorAll('button')].find(
    (node) => node.textContent === text,
  )!;
}
async function click(node: HTMLElement) {
  await act(async () => node.click());
}
async function choose() {
  await click(document.querySelector('[role="radio"]') as HTMLElement);
}
describe('CapacityRecoveryDialog', () => {
  it('shows the Chinese confirmation rather than the fallback English copy', async () => {
    await mount(undefined, 'zh-CN');
    expect(button('停止这些会话并继续')).toBeDefined();
    expect(document.body.textContent).toContain('选择要停止的工作区');
  });
  it('requires selection and explicit confirmation, then continues exactly once', async () => {
    const h = await mount();
    expect(h.stop).not.toHaveBeenCalled();
    expect(button('Stop these sessions and continue').disabled).toBe(true);
    await choose();
    await click(button('Stop these sessions and continue'));
    expect(h.stop).toHaveBeenCalledExactlyOnceWith({
      confirmInterruptions: true,
      expectedChannelId: 'child',
      expectedRuntimeEpoch: 1,
      expectedStopToken: 'token',
      expectedSessionIds: ['s1'],
    });
    expect(h.resume).toHaveBeenCalledOnce();
    expect(h.onClose).toHaveBeenCalledOnce();
  });
  it('cancel does not stop anything or resubmit', async () => {
    const h = await mount();
    await choose();
    await click(button('cancel'));
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });
  it('does not continue when the draft or owner changed while stopping', async () => {
    let resolve!: (value: DaemonRuntimeStopResult) => void;
    const h = await mount(
      vi.fn(
        () =>
          new Promise<DaemonRuntimeStopResult>((r) => {
            resolve = r;
          }),
      ),
    );
    await choose();
    await click(button('Stop these sessions and continue'));
    h.isCurrent.mockReturnValue(false);
    await act(async () => resolve(result));
    expect(h.resume).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'The draft, session or daemon has changed',
    );
  });
  it('does not report a stale intent when its own continuation changes the session', async () => {
    const h = await mount();
    let finish!: () => void;
    h.resume.mockImplementation(async () => {
      h.isCurrent.mockReturnValue(false);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await choose();
    await click(button('Stop these sessions and continue'));
    expect(h.resume).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain(
      'The draft, session or daemon has changed',
    );
    await act(async () => finish());
    expect(h.onClose).toHaveBeenCalledOnce();
  });
  it('does not continue after dismissal while the accepted stop is still pending', async () => {
    let resolve!: (value: DaemonRuntimeStopResult) => void;
    const h = await mount(
      vi.fn(
        () =>
          new Promise<DaemonRuntimeStopResult>((r) => {
            resolve = r;
          }),
      ),
    );
    await choose();
    await click(button('Stop these sessions and continue'));
    act(() => root.unmount());
    await act(async () => resolve(result));
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.resume).not.toHaveBeenCalled();
  });
  it('keeps an unknown outcome locked until a matching receipt is observed without repeating POST', async () => {
    const h = await mount(
      vi.fn().mockRejectedValue(new TypeError('network lost')),
    );
    await choose();
    await click(button('Stop these sessions and continue'));
    expect(h.stop).toHaveBeenCalledOnce();
    expect(
      (document.querySelector('[role="radio"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    h.workspace.lastStop = result;
    await click(button('Refresh status'));
    expect(h.resume).not.toHaveBeenCalled();
    await click(button('Continue original operation'));
    expect(h.resume).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('refreshes a rejected stale confirmation and requires a new selection', async () => {
    const h = await mount(
      vi
        .fn()
        .mockRejectedValue(
          new DaemonHttpError(
            409,
            { code: 'workspace_runtime_stop_stale' },
            'Changed',
          ),
        ),
    );
    await choose();
    await click(button('Stop these sessions and continue'));
    expect(h.runtimeStopOptions).toHaveBeenCalledTimes(2);
    expect(button('Stop these sessions and continue').disabled).toBe(true);
    expect(h.resume).not.toHaveBeenCalled();
  });
});
