// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DaemonWorkspaceSettingsStatus } from '@qwen-code/sdk/daemon';
import type { WebShellApprovalMode } from '../utils/planMode';

const mocks = vi.hoisted(() => {
  const settings = vi.fn<() => Promise<DaemonWorkspaceSettingsStatus>>();
  const workspaceByCwd = vi.fn(() => ({ workspaceSettings: settings }));
  return {
    settings,
    workspaceByCwd,
    client: { workspaceByCwd },
    capabilities: { features: [] as string[] },
    status: 'connected',
    version: 0,
  };
});
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
  useWorkspace: () => ({
    client: mocks.client,
    capabilities: mocks.capabilities,
    status: mocks.status,
  }),
  useWorkspaceEventSignals: () => ({ settingsVersion: mocks.version }),
}));
const { useApprovalModes } = await import('./useApprovalModes');

let root: Root;
let container: HTMLDivElement;
function status(modes: string[]): DaemonWorkspaceSettingsStatus {
  return {
    v: 1,
    settings: [
      {
        key: 'ui.allowedApprovalModes',
        type: 'array',
        label: 'Modes',
        category: 'UI',
        requiresRestart: false,
        default: [],
        values: { effective: modes },
      },
    ],
  };
}
function Probe({
  cwd,
  allowed,
}: {
  cwd?: string;
  allowed?: readonly WebShellApprovalMode[];
}) {
  return <span>{useApprovalModes(cwd, allowed).join(',')}</span>;
}
function render(cwd?: string, allowed?: readonly WebShellApprovalMode[]) {
  act(() => root.render(<Probe cwd={cwd} allowed={allowed} />));
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.settings.mockReset().mockResolvedValue(status(['default']));
  mocks.workspaceByCwd.mockClear();
  mocks.client = { workspaceByCwd: mocks.workspaceByCwd };
  mocks.capabilities = {
    features: ['workspace_qualified_rest_core', 'workspace_settings'],
  };
  mocks.status = 'connected';
  mocks.version = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('reads only the requested workspace and clears choices when its target changes', async () => {
  mocks.settings.mockResolvedValueOnce(status(['auto']));
  render('/secondary');
  await flush();
  expect(mocks.workspaceByCwd).toHaveBeenCalledWith('/secondary');
  expect(container.textContent).toBe('auto');
  render('/third');
  expect(container.textContent).toBe('default,auto-edit,auto,yolo');
  await flush();
  expect(mocks.workspaceByCwd).toHaveBeenLastCalledWith('/third');
  expect(container.textContent).toBe('default');
});

it('honors host overrides including empty lists without reading settings', async () => {
  render('/secondary', ['auto']);
  expect(container.textContent).toBe('auto');
  render('/secondary', []);
  expect(container.textContent).toBe('');
  expect(mocks.workspaceByCwd).not.toHaveBeenCalled();
  render('/secondary');
  await flush();
  expect(container.textContent).toBe('default');
});

it('reloads after a settings event', async () => {
  render('/secondary');
  await flush();
  mocks.settings.mockResolvedValueOnce(status(['auto']));
  mocks.version++;
  render('/secondary');
  await flush();
  expect(container.textContent).toBe('auto');
  expect(mocks.settings).toHaveBeenCalledTimes(2);
});

it('ignores a late response from the previous workspace', async () => {
  let resolveOld!: (value: DaemonWorkspaceSettingsStatus) => void;
  mocks.settings.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  render('/old');
  mocks.settings.mockResolvedValueOnce(status(['auto']));
  render('/secondary');
  await flush();
  await act(async () => {
    resolveOld(status(['yolo']));
  });
  expect(container.textContent).toBe('auto');
});

it('does not reuse a prior daemon setting for the same path', async () => {
  render('/secondary');
  await flush();
  expect(container.textContent).toBe('default');
  mocks.client = { workspaceByCwd: mocks.workspaceByCwd };
  mocks.settings.mockRejectedValueOnce(new Error('unavailable'));
  render('/secondary');
  expect(container.textContent).toBe('default,auto-edit,auto,yolo');
  await flush();
  // The new client has no successful read to fall back on: fail closed
  // rather than revive the old client's list or offer every mode.
  expect(container.textContent).toBe('');
});

it('never reads primary settings for an absent workspace or failed scoped request', async () => {
  render();
  expect(mocks.workspaceByCwd).not.toHaveBeenCalled();
  mocks.settings.mockRejectedValueOnce(new Error('workspace unavailable'));
  render('/missing');
  await flush();
  expect(mocks.workspaceByCwd).toHaveBeenCalledOnce();
  expect(mocks.workspaceByCwd).toHaveBeenCalledWith('/missing');
  expect(container.textContent).toBe('');
});

it('retries a failed read on the next settings event', async () => {
  mocks.settings.mockRejectedValueOnce(new Error('unavailable'));
  render('/secondary');
  await flush();
  expect(container.textContent).toBe('');
  mocks.version++;
  render('/secondary');
  await flush();
  expect(mocks.settings).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('default');
});

it('keeps the default list and skips the read when the daemon lacks the qualified settings route', async () => {
  mocks.capabilities = { features: [] };
  render('/secondary');
  await flush();
  expect(mocks.workspaceByCwd).not.toHaveBeenCalled();
  expect(container.textContent).toBe('default,auto-edit,auto,yolo');
});

it('retries a failed read when the workspace reconnects', async () => {
  mocks.settings.mockRejectedValueOnce(new Error('unavailable'));
  render('/secondary');
  await flush();
  expect(container.textContent).toBe('');
  mocks.status = 'connecting';
  render('/secondary');
  await flush();
  // No doomed request while the workspace is still reconnecting.
  expect(mocks.settings).toHaveBeenCalledTimes(1);
  mocks.status = 'connected';
  render('/secondary');
  await flush();
  expect(mocks.settings).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('default');
});

it('keeps the last-known-good list when a reload fails', async () => {
  mocks.settings.mockResolvedValueOnce(status(['auto']));
  render('/secondary');
  await flush();
  expect(container.textContent).toBe('auto');
  mocks.settings.mockRejectedValueOnce(new Error('unavailable'));
  mocks.version++;
  render('/secondary');
  await flush();
  expect(mocks.settings).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('auto');
});
