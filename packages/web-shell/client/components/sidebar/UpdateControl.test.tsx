// @vitest-environment jsdom
import { act, useState } from 'react';
import { getByRole, queryByRole } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonUpdateStatus } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { cleanupReact, flushReact, mountReact } from '../../test/reactHarness';
import { UpdateControl } from './UpdateControl';

const available: DaemonUpdateStatus = {
  state: 'available',
  currentVersion: '0.24.4',
  latestVersion: '0.24.6',
  canInstall: true,
};
const ready: DaemonUpdateStatus = {
  ...available,
  state: 'ready',
  canInstall: false,
};
const client = {
  daemonUpdateStatus: vi.fn<() => Promise<DaemonUpdateStatus>>(),
  prepareDaemonUpdate: vi.fn<() => Promise<DaemonUpdateStatus>>(),
  restartDaemonForUpdate: vi.fn<() => Promise<DaemonUpdateStatus>>(),
};
const onError = vi.fn();
const onRestarted = vi.fn();

function render(collapsed = false, language: 'en' | 'zh-CN' = 'en') {
  return mountReact(
    <I18nProvider language={language}>
      <UpdateControl
        client={client}
        collapsed={collapsed}
        currentVersion="0.24.4"
        onError={onError}
        onRestarted={onRestarted}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  client.daemonUpdateStatus.mockResolvedValue(available);
  client.prepareDaemonUpdate.mockResolvedValue({
    ...available,
    state: 'installing',
  });
  client.restartDaemonForUpdate.mockResolvedValue({
    ...ready,
    state: 'restarting',
  });
});

afterEach(() => {
  cleanupReact();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('UpdateControl', () => {
  it('downloads silently and only shows the update button once ready', async () => {
    const container = render();
    await flushReact();
    expect(client.prepareDaemonUpdate).toHaveBeenCalledTimes(1);
    expect(queryByRole(container, 'button')).toBeNull();
    expect(client.restartDaemonForUpdate).not.toHaveBeenCalled();
    client.daemonUpdateStatus.mockResolvedValue(ready);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const button = getByRole(container, 'button', { name: 'Update' });
    expect(button.title).toBe('Update to v0.24.6 and restart');
    expect(client.restartDaemonForUpdate).not.toHaveBeenCalled();
  });

  it.each(['up-to-date', 'unavailable', 'error', 'available'] as const)(
    'hides unsupported or unprepared updates (%s)',
    async (state) => {
      client.daemonUpdateStatus.mockResolvedValue({
        ...available,
        state,
        canInstall: false,
      });
      const container = render();
      await flushReact();
      expect(queryByRole(container, 'button')).toBeNull();
      expect(client.prepareDaemonUpdate).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('restarts only on click, tolerates downtime, and reloads after the new version starts', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    const button = getByRole(container, 'button', { name: 'Update' });
    await act(async () => {
      button.click();
      button.click();
    });
    expect(client.restartDaemonForUpdate).toHaveBeenCalledTimes(1);
    expect(
      getByRole(container, 'button', { name: 'Restarting…' }).hasAttribute(
        'disabled',
      ),
    ).toBe(true);
    client.daemonUpdateStatus.mockRejectedValueOnce(new Error('offline'));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onRestarted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    client.daemonUpdateStatus.mockResolvedValue({
      state: 'up-to-date',
      currentVersion: '0.24.6',
      canInstall: false,
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onRestarted).toHaveBeenCalledTimes(1);
  });

  it('compares against the clicked version even if capabilities refresh first', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    let setVersion: (version: string) => void = () => {};
    function Harness() {
      const [version, updateVersion] = useState('0.24.4');
      setVersion = updateVersion;
      return (
        <I18nProvider language="en">
          <UpdateControl
            client={client}
            collapsed={false}
            currentVersion={version}
            onError={onError}
            onRestarted={onRestarted}
          />
        </I18nProvider>
      );
    }
    const container = mountReact(<Harness />);
    await flushReact();
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    await act(async () => setVersion('0.24.6'));
    client.daemonUpdateStatus.mockResolvedValue({
      state: 'up-to-date',
      currentVersion: '0.24.6',
      canInstall: false,
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onRestarted).toHaveBeenCalledTimes(1);
  });

  it('returns to the click-time task URL after navigation during restart', async () => {
    const taskUrl = `${window.location.origin}/session/task-1?workspace=other#turn-2`;
    window.history.replaceState(null, '', taskUrl);
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    window.history.replaceState(null, '', '/');
    client.daemonUpdateStatus.mockResolvedValue({
      state: 'up-to-date',
      currentVersion: '0.24.6',
      canInstall: false,
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onRestarted).toHaveBeenCalledExactlyOnceWith(taskUrl);
  });

  it('reports an explicit restart failure and allows retry', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    client.restartDaemonForUpdate.mockRejectedValueOnce(new Error('failed'));
    const container = render();
    await flushReact();
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    expect(client.restartDaemonForUpdate).toHaveBeenCalledTimes(2);
  });

  it('stops waiting and reports when a restart does not finish', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    client.daemonUpdateStatus.mockRejectedValue(new Error('offline'));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRestarted).not.toHaveBeenCalled();
    expect(
      getByRole(container, 'button', { name: 'Update' }).hasAttribute(
        'disabled',
      ),
    ).toBe(false);
  });

  it('keeps the collapsed button accessible in Chinese', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render(true, 'zh-CN');
    await flushReact();
    const button = getByRole(container, 'button', { name: '更新' });
    expect(button.textContent).toBe('');
    expect(button.title).toBe('更新至 v0.24.6 并重启');
  });

  it('ignores pending checks and stops polling after unmount', async () => {
    let resolve: (value: DaemonUpdateStatus) => void = () => {};
    client.daemonUpdateStatus.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render();
    cleanupReact();
    await act(async () => {
      resolve(available);
    });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(client.prepareDaemonUpdate).not.toHaveBeenCalled();
    expect(client.daemonUpdateStatus).toHaveBeenCalledTimes(1);
  });
});
