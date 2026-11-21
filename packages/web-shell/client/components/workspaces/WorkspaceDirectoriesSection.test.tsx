// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceDirectoriesSection } from './WorkspaceDirectoriesSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const connectionState: {
  capabilities?: { features?: string[] };
} = {};
const workspaceState: {
  workspaceCwd?: string;
  capabilities?: { workspaces?: Array<Record<string, unknown>> };
} = {};
const actions = {
  listWorkspaceDirectories: vi.fn(),
  addWorkspaceDirectory: vi.fn(),
  removeWorkspaceDirectory: vi.fn(),
  suggestWorkspacePaths: vi.fn(),
  pickWorkspaceDirectory: vi.fn(),
};

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connectionState,
  useWorkspace: () => workspaceState,
  useWorkspaceActions: () => actions,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  connectionState.capabilities = { features: ['workspace_directories'] };
  workspaceState.workspaceCwd = '/ws';
  actions.listWorkspaceDirectories.mockReset();
  actions.addWorkspaceDirectory.mockReset();
  actions.removeWorkspaceDirectory.mockReset();
  actions.suggestWorkspacePaths.mockReset();
  actions.pickWorkspaceDirectory.mockReset();
  actions.listWorkspaceDirectories.mockResolvedValue({
    v: 1,
    primaryDirectory: '/ws',
    directories: ['/extra'],
  });
  // The dialog debounces a suggestion fetch once it mounts; the mock must stay
  // a promise even when the timer fires before the test closes the dialog.
  actions.suggestWorkspacePaths.mockResolvedValue({
    dir: '/ws',
    sep: '/',
    suggestions: [],
    truncated: false,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <WorkspaceDirectoriesSection />
      </I18nProvider>,
    );
  });
}

describe('WorkspaceDirectoriesSection', () => {
  it('lists the primary and extra directories', async () => {
    await render();
    expect(actions.listWorkspaceDirectories).toHaveBeenCalledWith('/ws');
    expect(container.textContent).toContain('/ws');
    expect(container.textContent).toContain('/extra');
    expect(container.textContent).toContain('Primary');
  });

  it('renders nothing when the daemon does not advertise the feature', async () => {
    connectionState.capabilities = { features: [] };
    await render();
    expect(container.textContent).toBe('');
    expect(actions.listWorkspaceDirectories).not.toHaveBeenCalled();
  });

  it('renders nothing for an SSH workspace', async () => {
    // Registration rewrites an `ssh://` URL to a local mirror directory, so a
    // production SSH workspace reaches the section with a plain local cwd and
    // only the workspace entry's SSH marker distinguishes it.
    workspaceState.workspaceCwd = '/mirror/ws';
    workspaceState.capabilities = {
      workspaces: [
        { cwd: '/mirror/ws', ssh: { host: 'host', directory: '/srv/ws' } },
      ],
    };
    await render();
    expect(container.textContent).toBe('');
  });

  it('hides Browse when the daemon does not advertise the native picker', async () => {
    // The picker is an independent host probe: a headless daemon still serves
    // this section but answers the picker with 501, so Browse must not render.
    await render();
    const browse = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Browse'));
    expect(browse).toBeUndefined();
  });

  it('disables Add while a removal is in flight', async () => {
    // The mutation is a settings read-modify-write, so an add issued while a
    // remove is pending can overwrite the pending change.
    let resolveRemove: (value: unknown) => void = () => {};
    actions.removeWorkspaceDirectory.mockReturnValue(
      new Promise((resolve) => {
        resolveRemove = resolve;
      }),
    );
    await render();
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove directory"]',
    )!;
    await act(async () => remove.click());
    const add = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Add directory'))!;
    expect(add.disabled).toBe(true);
    await act(async () => {
      resolveRemove({
        v: 1,
        primaryDirectory: '/ws',
        directories: [],
        changed: true,
        warnings: [],
      });
    });
    expect(actions.addWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('removes a directory and applies the returned list', async () => {
    actions.removeWorkspaceDirectory.mockResolvedValue({
      v: 1,
      primaryDirectory: '/ws',
      directories: [],
      changed: true,
      warnings: [],
    });
    await render();
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove directory"]',
    )!;
    await act(async () => remove.click());
    expect(actions.removeWorkspaceDirectory).toHaveBeenCalledWith(
      '/ws',
      '/extra',
    );
    expect(container.textContent).not.toContain('/extra');
  });

  it('adds a directory through the dialog', async () => {
    vi.useFakeTimers();
    actions.addWorkspaceDirectory.mockResolvedValue({
      v: 1,
      primaryDirectory: '/ws',
      directories: ['/extra', '/other'],
      changed: true,
      warnings: [],
    });
    await render();
    const add = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Add directory'))!;
    await act(async () => add.click());
    const input = document.querySelector<HTMLInputElement>(
      '#add-workspace-path',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, '/other');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(actions.suggestWorkspacePaths).toHaveBeenCalled();
    const submit = document.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});
    expect(actions.addWorkspaceDirectory).toHaveBeenCalledWith('/ws', '/other');
    expect(container.textContent).toContain('/other');
  });
});
