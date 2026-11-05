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
// The daemon reports `restarting` from the acknowledged restart until the
// process is replaced. A settled state afterwards means a new process
// answered, which is what the control distinguishes success from failure by.
const restarting: DaemonUpdateStatus = {
  ...ready,
  state: 'restarting',
};
const manual: DaemonUpdateStatus = {
  ...available,
  canInstall: false,
  instructions: [
    'Run the following to update:',
    '  npm install -g @qwen-code/qwen-code@0.24.6',
  ],
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

  it('shows manual instructions when one-click is unavailable and never restarts', async () => {
    client.daemonUpdateStatus.mockResolvedValue(manual);
    const container = render();
    await flushReact();
    expect(client.prepareDaemonUpdate).not.toHaveBeenCalled();
    const button = getByRole(container, 'button', { name: 'Update' });
    expect(button.title).toBe('Update to v0.24.6 (manual)');
    await act(async () => {
      button.click();
    });
    const panel = document.querySelector('[data-web-shell-update-manual]');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain(
      'npm install -g @qwen-code/qwen-code@0.24.6',
    );
    expect(panel!.textContent).toContain(
      'cannot be updated from the Web Shell',
    );
    expect(client.prepareDaemonUpdate).not.toHaveBeenCalled();
    expect(client.restartDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('does not promise a command when the instructions are prose', async () => {
    client.daemonUpdateStatus.mockResolvedValue({
      ...manual,
      instructions: ['Running via npx, update not applicable.'],
    });
    const container = render();
    await flushReact();
    await act(async () => {
      getByRole(container, 'button', { name: 'Update' }).click();
    });
    const panel = document.querySelector('[data-web-shell-update-manual]');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain(
      'Running via npx, update not applicable.',
    );
    expect(panel!.textContent).toContain('Update guidance:');
    expect(panel!.textContent).not.toContain('Run the following in a terminal');
    expect(client.prepareDaemonUpdate).not.toHaveBeenCalled();
    expect(client.restartDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('keeps the manual-instructions button accessible when collapsed in Chinese', async () => {
    client.daemonUpdateStatus.mockResolvedValue(manual);
    const container = render(true, 'zh-CN');
    await flushReact();
    const button = getByRole(container, 'button', { name: '更新' });
    expect(button.textContent).toBe('');
    expect(button.title).toBe('更新至 v0.24.6（手动）');
    expect(client.prepareDaemonUpdate).not.toHaveBeenCalled();
  });

  it('restarts only on click, tolerates downtime, and reloads after the new version starts', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    const button = getByRole(container, 'button', { name: 'Update' });
    client.daemonUpdateStatus.mockResolvedValue(restarting);
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
    client.daemonUpdateStatus.mockResolvedValue(restarting);
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
    client.daemonUpdateStatus.mockResolvedValue(restarting);
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
    // Unreachable from the click onward, so the continuous-downtime deadline
    // starts at the click itself.
    client.daemonUpdateStatus.mockRejectedValue(new Error('offline'));
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRestarted).not.toHaveBeenCalled();
    expect(
      getByRole(container, 'button', { name: 'Update' }).hasAttribute(
        'disabled',
      ),
    ).toBe(false);
  });

  it('keeps waiting while a reachable daemon stages a newer release', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    client.daemonUpdateStatus.mockResolvedValue({
      ...restarting,
      latestVersion: '0.24.9',
    });
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    // Re-resolving and staging the current latest happens after the 202 and
    // can outlast a deadline measured from the click.
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(onError).not.toHaveBeenCalled();
    expect(onRestarted).not.toHaveBeenCalled();
    expect(
      getByRole(container, 'button', { name: 'Restarting…' }).hasAttribute(
        'disabled',
      ),
    ).toBe(true);
    client.daemonUpdateStatus.mockResolvedValue({
      state: 'up-to-date',
      currentVersion: '0.24.9',
      canInstall: false,
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onRestarted).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('measures the restart deadline from continuous downtime, not the click', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    client.daemonUpdateStatus.mockResolvedValue(restarting);
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    client.daemonUpdateStatus.mockRejectedValue(new Error('offline'));
    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(onError).not.toHaveBeenCalled();
    client.daemonUpdateStatus.mockResolvedValue(restarting);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    client.daemonUpdateStatus.mockRejectedValue(new Error('offline'));
    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(onError).not.toHaveBeenCalled();
    expect(onRestarted).not.toHaveBeenCalled();
  });

  it('reports failure when the daemon comes back on the same version', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    client.daemonUpdateStatus.mockResolvedValue(restarting);
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    // Process replacement is not guaranteed to land on the new build: the
    // daemon can come back reachable, settled, and unchanged. Waiting for a
    // version change that will never arrive must not hang the control. The
    // settled state here is one that renders an entry, so handing it back is
    // observable rather than hidden by a state that renders nothing anyway.
    client.daemonUpdateStatus.mockResolvedValue(manual);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRestarted).not.toHaveBeenCalled();
    expect(
      queryByRole(container, 'button', { name: 'Restarting…' }),
    ).toBeNull();
    // The control offers what the daemon now reports immediately, instead of
    // vanishing until the next idle poll a minute later.
    expect(
      getByRole(container, 'button', { name: 'Update' }).hasAttribute(
        'disabled',
      ),
    ).toBe(false);
  });

  it('publishes the settled state even when the poll right after it drops', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    client.daemonUpdateStatus.mockResolvedValue(restarting);
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    // Clearing the restart re-runs the poll loop, which would normally publish
    // the settled state itself. A daemon that just restarted can drop that
    // very next request, so the failure path must publish what it already has
    // rather than leave a stale restarting status rendering nothing.
    client.daemonUpdateStatus.mockResolvedValueOnce(manual);
    client.daemonUpdateStatus.mockRejectedValue(new Error('offline'));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRestarted).not.toHaveBeenCalled();
    expect(
      getByRole(container, 'button', { name: 'Update' }).hasAttribute(
        'disabled',
      ),
    ).toBe(false);
  });

  it('ignores a settled poll that lands before the restart is acknowledged', async () => {
    client.daemonUpdateStatus.mockResolvedValue(ready);
    const container = render();
    await flushReact();
    let acknowledge: (value: DaemonUpdateStatus) => void = () => {};
    client.restartDaemonForUpdate.mockReturnValue(
      new Promise<DaemonUpdateStatus>((resolve) => {
        acknowledge = resolve;
      }),
    );
    // Polling starts on the click, before the POST resolves, so a poll can
    // still observe the pre-click state. That is not a daemon that settled
    // after a restart, and must not be reported as a failed update.
    client.daemonUpdateStatus.mockResolvedValue({
      state: 'up-to-date',
      currentVersion: '0.24.4',
      canInstall: false,
    });
    await act(async () =>
      getByRole(container, 'button', { name: 'Update' }).click(),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(onError).not.toHaveBeenCalled();
    expect(
      getByRole(container, 'button', { name: 'Restarting…' }).hasAttribute(
        'disabled',
      ),
    ).toBe(true);
    // Once acknowledged, that same settled state does mean the replacement
    // did not land.
    await act(async () => {
      acknowledge(restarting);
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRestarted).not.toHaveBeenCalled();
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
