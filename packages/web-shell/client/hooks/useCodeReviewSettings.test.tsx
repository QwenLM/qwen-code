// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { useCodeReviewSettings } from './useCodeReviewSettings';

const load = vi.fn();
const save = vi.fn();
const client = {
  githubPullRequestSettings: load,
  updateGitHubPullRequestSettings: save,
} as unknown as DaemonClient;
let result: ReturnType<typeof useCodeReviewSettings>;
let root: Root;
let container: HTMLDivElement;
const status = (enabled: boolean, locked = false) => ({
  v: 1 as const,
  enabled,
  userEnabled: enabled,
  locked,
});
function Harness({
  daemon,
  supported,
  revision,
}: {
  daemon: DaemonClient;
  supported: boolean;
  revision: number;
}) {
  result = useCodeReviewSettings(daemon, supported, revision);
  return null;
}
async function render(daemon = client, supported = true, revision = 0) {
  await act(async () =>
    root.render(
      <Harness daemon={daemon} supported={supported} revision={revision} />,
    ),
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  load.mockResolvedValue(status(false));
  save.mockResolvedValue(status(true));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
describe('account code review settings', () => {
  it('does not contact an unsupported daemon', async () => {
    await render(client, false);
    await act(async () => result.setEnabled(true));
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
  });
  it('writes the account switch and uses its effective readback', async () => {
    await render();
    await act(async () => result.setEnabled(true));
    expect(save).toHaveBeenCalledWith(true);
    expect(result.enabled).toBe(true);
    save.mockResolvedValue({ ...status(true, true), userEnabled: false });
    await act(async () => result.setEnabled(false));
    expect(result.enabled).toBe(true);
    expect(result.userEnabled).toBe(false);
    expect(result.locked).toBe(true);
    await act(async () => result.setEnabled(false));
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('keeps a pending write isolated when switching daemons', async () => {
    let finish!: (value: ReturnType<typeof status>) => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const secondLoad = vi.fn().mockResolvedValue(status(false));
    const second = {
      githubPullRequestSettings: secondLoad,
    } as unknown as DaemonClient;
    await render();
    let pending!: Promise<void>;
    act(() => {
      pending = result.setEnabled(true);
    });
    await render(second);
    expect(result.busy).toBe(true);
    expect(result.enabled).toBe(false);
    await act(async () => {
      finish(status(true));
      await pending;
    });
    expect(result.busy).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.loaded).toBe(true);
    expect(secondLoad).toHaveBeenCalledOnce();
  });
  it('ignores old daemon responses and fails closed on reload errors', async () => {
    let finish!: (value: ReturnType<typeof status>) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const secondLoad = vi.fn().mockResolvedValue(status(true));
    const second = {
      githubPullRequestSettings: secondLoad,
    } as unknown as DaemonClient;
    await render();
    await render(second);
    await act(async () => {
      finish(status(false));
    });
    expect(result.enabled).toBe(true);
    secondLoad.mockRejectedValue(new Error('settings unavailable'));
    await render(second, true, 1);
    expect(result.enabled).toBe(false);
    expect(result.error).toBe('settings unavailable');
  });
  it('does not let a stale refresh overwrite a successful write', async () => {
    let finish!: (value: ReturnType<typeof status>) => void;
    await render();
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.reload();
    });
    await act(async () => result.setEnabled(true));
    await act(async () => {
      finish(status(false));
      await pending;
    });
    expect(result.enabled).toBe(true);
  });
});
