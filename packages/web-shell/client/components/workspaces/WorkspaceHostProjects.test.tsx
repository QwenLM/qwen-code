// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { cleanupReact, flushReact, mountReact } from '../../test/reactHarness';

const state = vi.hoisted(() => ({
  baseUrl: '',
  capabilities: vi.fn(),
  clientConstructs: [] as Array<{ baseUrl: string }>,
  openHostedWorkspace: vi.fn(),
}));

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonClient: class {
    constructor(opts: { baseUrl: string }) {
      state.clientConstructs.push(opts);
    }

    capabilities = state.capabilities;
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ baseUrl: state.baseUrl }),
}));

vi.mock('../../config/workspace-hosts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../config/workspace-hosts',
  );
  return { ...actual, openHostedWorkspace: state.openHostedWorkspace };
});

import {
  rememberWorkspaceHost,
  WorkspaceHostsEnabled,
} from '../../config/workspace-hosts';
import {
  OtherHostProjects,
  WorkspaceHostHeading,
} from './WorkspaceHostProjects';

function renderWithHosts(node: ReactElement): HTMLElement {
  return mountReact(
    <I18nProvider language="en">
      <WorkspaceHostsEnabled.Provider value={true}>
        {node}
      </WorkspaceHostsEnabled.Provider>
    </I18nProvider>,
  );
}

function buttonWithText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === text,
  );
}

describe('WorkspaceHostHeading / OtherHostProjects', () => {
  beforeEach(() => {
    localStorage.clear();
    state.baseUrl = '';
    state.capabilities.mockReset();
    state.clientConstructs.length = 0;
    state.openHostedWorkspace.mockReset();
  });

  afterEach(() => {
    cleanupReact();
  });

  it('keeps the plain list until a second host is known', () => {
    const heading = renderWithHosts(<WorkspaceHostHeading />);
    expect(heading.textContent).toBe('');
    const others = renderWithHosts(<OtherHostProjects />);
    expect(
      others.querySelector('[data-testid="other-host-projects"]'),
    ).toBeNull();
  });

  it('names the connected local host and navigates to a saved remote project', () => {
    rememberWorkspaceHost('https://remote.example', [
      { id: 'ws9', cwd: '/srv/repo' },
    ]);
    const container = renderWithHosts(
      <>
        <WorkspaceHostHeading />
        <OtherHostProjects />
      </>,
    );
    expect(
      container.querySelector('[data-testid="other-host-projects"]'),
    ).not.toBeNull();
    const projectButton = buttonWithText(container, 'repo');
    expect(projectButton?.getAttribute('title')).toBe(
      'https://remote.example — /srv/repo',
    );
    projectButton?.click();
    expect(state.openHostedWorkspace).toHaveBeenCalledWith(
      'https://remote.example',
      'ws9',
    );
    // A same-origin connection never probes the page daemon for a refresh.
    expect(state.clientConstructs).toEqual([]);
  });

  it('synthesizes the local group while cross-origin and refreshes it from the page daemon', async () => {
    state.baseUrl = 'https://remote.example';
    state.capabilities.mockResolvedValue({
      workspaces: [
        { id: 'l1', cwd: '/home/me/a' },
        { id: 'l2', cwd: '/home/me/live', kind: 'live' },
      ],
    });
    const container = renderWithHosts(
      <>
        <WorkspaceHostHeading />
        <OtherHostProjects />
      </>,
    );
    // Heading names the connected remote host; the local group exists with a
    // way back even before the refresh resolves.
    expect(container.textContent).toContain('remote.example');
    expect(container.textContent).toContain('Local');
    await flushReact();
    expect(buttonWithText(container, 'a')).toBeDefined();
    expect(state.clientConstructs).toEqual([
      { baseUrl: window.location.origin },
    ]);
    expect(state.capabilities).toHaveBeenCalled();
    // Live entries stay out of the saved catalog.
    expect(buttonWithText(container, 'live')).toBeUndefined();
  });
});
