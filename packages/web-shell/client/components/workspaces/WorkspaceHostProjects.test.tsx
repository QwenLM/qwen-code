// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { cleanupReact, flushReact, mountReact } from '../../test/reactHarness';

const state = vi.hoisted(() => ({
  baseUrl: '',
  hosts: {} as Record<
    string,
    {
      capabilities: () => Promise<unknown>;
      capabilitiesCalls?: number;
      listWorkspaceSessionsPage?: (cwd: string) => Promise<unknown>;
    }
  >,
  clientConstructs: [] as Array<{ baseUrl: string; token?: string }>,
  openHostedWorkspace: vi.fn(),
}));

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonClient: class {
    baseUrl: string;

    constructor(opts: { baseUrl: string; token?: string }) {
      state.clientConstructs.push(opts);
      this.baseUrl = opts.baseUrl;
    }

    capabilities = () =>
      state.hosts[this.baseUrl]?.capabilities() ??
      Promise.reject(new Error(`no daemon for ${this.baseUrl}`));

    workspaceByCwd = (cwd: string) => ({
      listWorkspaceSessionsPage: () =>
        state.hosts[this.baseUrl]?.listWorkspaceSessionsPage?.(cwd) ??
        Promise.reject(new Error(`no sessions for ${this.baseUrl}`)),
    });

    dispose = () => undefined;
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

import { DaemonClient } from '@qwen-code/sdk/daemon';
import { DaemonTargetProvider } from '../../config/daemon-target';
import { rememberRemoteConnection } from '../../config/remote-connections';
import {
  readWorkspaceHosts,
  rememberWorkspaceHost,
  WorkspaceHostsEnabled,
} from '../../config/workspace-hosts';
import { useHostFanout } from '../../config/host-fanout';
import { WorkspaceSection } from '../sidebar/WorkspaceSection';
import {
  OtherHostProjects,
  WorkspaceHostHeading,
} from './WorkspaceHostProjects';

const PAGE_ORIGIN = window.location.origin;

function registerHost(
  origin: string,
  options: {
    failWith?: Error;
    workspaces?: unknown[];
    sessions?: Record<string, unknown[]>;
  } = {},
): void {
  state.hosts[origin] = {
    capabilities: options.failWith
      ? () => {
          const host = state.hosts[origin]!;
          host.capabilitiesCalls = (host.capabilitiesCalls ?? 0) + 1;
          return Promise.reject(options.failWith);
        }
      : () => {
          const host = state.hosts[origin]!;
          host.capabilitiesCalls = (host.capabilitiesCalls ?? 0) + 1;
          return Promise.resolve({ workspaces: options.workspaces ?? [] });
        },
    listWorkspaceSessionsPage: (cwd) =>
      Promise.resolve({ sessions: options.sessions?.[cwd] ?? [] }),
  };
}

function renderWithHosts(node: ReactElement): HTMLElement {
  return mountReact(
    <I18nProvider language="en">
      <WorkspaceHostsEnabled.Provider value={true}>
        {node}
      </WorkspaceHostsEnabled.Provider>
    </I18nProvider>,
  );
}

async function settle(): Promise<void> {
  await flushReact();
  await flushReact();
  await flushReact();
}

function buttonWithText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function sessionRow(container: HTMLElement, label: string): HTMLElement | null {
  const title = Array.from(
    container.querySelectorAll<HTMLElement>('[data-web-shell-session-title]'),
  ).find((element) => element.textContent === label);
  return title?.closest<HTMLElement>('[role="button"]') ?? null;
}

describe('WorkspaceHostHeading / OtherHostProjects', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    state.baseUrl = '';
    for (const origin of Object.keys(state.hosts)) delete state.hosts[origin];
    state.clientConstructs.length = 0;
    state.openHostedWorkspace.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanupReact();
    vi.restoreAllMocks();
  });

  it('keeps the plain list until a second host is known', () => {
    const heading = renderWithHosts(<WorkspaceHostHeading />);
    expect(heading.textContent).toBe('');
    const others = renderWithHosts(<OtherHostProjects />);
    expect(
      others.querySelector('[data-testid="other-host-projects"]'),
    ).toBeNull();
  });

  it('renders live workspaces and sessions from every online host', async () => {
    const onOpenHostSession = vi.fn();
    rememberWorkspaceHost('https://host-a.example', [
      { id: 'a1', cwd: '/srv/saved-a' },
    ]);
    rememberWorkspaceHost('https://host-b.example', [
      { id: 'b1', cwd: '/srv/saved-b' },
    ]);
    registerHost('https://host-a.example', {
      workspaces: [
        { id: 'wa', cwd: '/srv/repo-a', primary: true, trusted: true },
      ],
      sessions: {
        '/srv/repo-a': [
          {
            sessionId: 's-a',
            workspaceCwd: '/srv/repo-a',
            displayName: 'Alpha fix',
          },
        ],
      },
    });
    registerHost('https://host-b.example', {
      workspaces: [
        { id: 'wb', cwd: '/opt/repo-b', primary: true, trusted: true },
      ],
      sessions: {
        '/opt/repo-b': [
          {
            sessionId: 's-b',
            workspaceCwd: '/opt/repo-b',
            displayName: 'Beta fix',
          },
        ],
      },
    });
    const container = renderWithHosts(
      <>
        <WorkspaceHostHeading />
        <OtherHostProjects onOpenHostSession={onOpenHostSession} />
      </>,
    );
    await settle();

    // Both hosts label a group, and the rows come from the daemons, not the
    // saved snapshots ('saved-a'/'saved-b' stay gone once live data lands).
    const groups = container.querySelector(
      '[data-testid="other-host-projects"]',
    );
    expect(groups?.textContent).toContain('host-a.example');
    expect(groups?.textContent).toContain('host-b.example');
    expect(groups?.textContent).toContain('repo-a');
    expect(groups?.textContent).toContain('repo-b');
    expect(groups?.textContent).not.toContain('saved-a');
    expect(groups?.textContent).not.toContain('saved-b');
    expect(groups?.querySelector('[data-testid="host-status"]')).toBeNull();

    sessionRow(container, 'Alpha fix')?.click();
    expect(onOpenHostSession).toHaveBeenCalledWith(
      'https://host-a.example',
      's-a',
      '/srv/repo-a',
    );
    sessionRow(container, 'Beta fix')?.click();
    expect(onOpenHostSession).toHaveBeenCalledWith(
      'https://host-b.example',
      's-b',
      '/opt/repo-b',
    );
  });

  it('falls back to the legacy navigation when no in-app opener is wired', async () => {
    rememberWorkspaceHost('https://host-c.example', []);
    registerHost('https://host-c.example', {
      workspaces: [
        { id: 'wc', cwd: '/srv/repo-c', primary: true, trusted: true },
      ],
      sessions: {
        '/srv/repo-c': [
          {
            sessionId: 's-c',
            workspaceCwd: '/srv/repo-c',
            displayName: 'Gamma fix',
          },
        ],
      },
    });
    const container = renderWithHosts(<OtherHostProjects />);
    await settle();

    sessionRow(container, 'Gamma fix')?.click();
    expect(state.openHostedWorkspace).toHaveBeenCalledWith(
      'https://host-c.example',
      'wc',
    );
  });

  it('keeps an offline host usable through its saved group with a muted hint', async () => {
    rememberWorkspaceHost('https://host-d.example', [
      { id: 'd1', cwd: '/srv/old-d' },
    ]);
    registerHost('https://host-d.example', {
      failWith: new Error('fetch failed'),
    });
    const container = renderWithHosts(<OtherHostProjects />);
    await settle();

    const hint = container.querySelector('[data-testid="host-status"]');
    expect(hint?.textContent).toBe('offline');
    expect(hint?.getAttribute('title')).toContain('last known');
    const row = buttonWithText(container, 'old-d');
    expect(row).toBeDefined();
    expect(row?.disabled).toBe(false);
    row?.click();
    expect(state.openHostedWorkspace).toHaveBeenCalledWith(
      'https://host-d.example',
      'd1',
    );
  });

  it('marks an unauthorized host and disables its saved projects', async () => {
    rememberWorkspaceHost('https://host-e.example', [
      { id: 'e1', cwd: '/srv/gated-e' },
    ]);
    registerHost('https://host-e.example', {
      failWith: new Error('Request failed with status 401'),
    });
    const container = renderWithHosts(<OtherHostProjects />);
    await settle();

    const hint = container.querySelector('[data-testid="host-status"]');
    expect(hint?.textContent).toBe('unauthorized');
    const row = buttonWithText(container, 'gated-e');
    expect(row?.disabled).toBe(true);
    expect(row?.getAttribute('title')).toContain('sign in');
    // The host label itself stays a way over — re-authentication starts there.
    buttonWithText(container, 'host-e.example')?.click();
    expect(state.openHostedWorkspace).toHaveBeenCalledWith(
      'https://host-e.example',
      undefined,
    );
  });

  it('synthesizes the local group while cross-origin and refreshes it from the page daemon', async () => {
    state.baseUrl = 'https://remote.example';
    window.history.replaceState(
      {},
      '',
      '/?daemon=https%3A%2F%2Fremote.example',
    );
    rememberWorkspaceHost('https://remote.example', []);
    registerHost('https://remote.example', { workspaces: [] });
    registerHost(PAGE_ORIGIN, {
      workspaces: [
        { id: 'l1', cwd: '/home/me/a', primary: true, trusted: true },
        {
          id: 'l2',
          cwd: '/home/me/live',
          kind: 'live',
          primary: true,
          trusted: true,
        },
      ],
    });
    const container = renderWithHosts(
      <>
        <WorkspaceHostHeading />
        <OtherHostProjects />
      </>,
    );
    // Heading names the connected remote host; the local group exists as the
    // way back even before the refresh resolves.
    expect(container.textContent).toContain('remote.example');
    expect(container.textContent).toContain('Local');
    await settle();

    expect(buttonWithText(container, 'a')).toBeDefined();
    expect(state.clientConstructs.map((opts) => opts.baseUrl)).toContain(
      PAGE_ORIGIN,
    );
    // Live entries stay out of the saved catalog.
    expect(
      readWorkspaceHosts()
        .find((host) => host.origin === PAGE_ORIGIN)
        ?.workspaces.map((ws) => ws.id),
    ).toEqual(['l1']);
    // A failed page-origin probe keeps the last saved group.
    state.hosts[PAGE_ORIGIN] = {
      capabilities: () => Promise.reject(new Error('fetch failed')),
    };
    await settle();
    expect(
      readWorkspaceHosts()
        .find((host) => host.origin === PAGE_ORIGIN)
        ?.workspaces.map((ws) => ws.id),
    ).toEqual(['l1']);
  });

  it('fans out to known remote connections even without a saved host entry', async () => {
    rememberRemoteConnection('https://host-f.example');
    registerHost('https://host-f.example', {
      workspaces: [
        { id: 'wf', cwd: '/srv/repo-f', primary: true, trusted: true },
      ],
    });
    const container = renderWithHosts(<OtherHostProjects />);
    await settle();

    expect(container.textContent).toContain('host-f.example');
    expect(buttonWithText(container, 'repo-f')).toBeDefined();
  });

  it('polls each host once no matter how many consumers subscribe', async () => {
    rememberWorkspaceHost('https://host-i.example', []);
    registerHost('https://host-i.example', {
      workspaces: [
        { id: 'wi', cwd: '/srv/repo-i', primary: true, trusted: true },
      ],
    });
    // The sidebar group (useHostCapabilities) and the App-level fan-out
    // (useHostFanout) both subscribe; the shared store must issue exactly
    // one capabilities round per host (PR review: was 3 pollers per host).
    function FanoutSubscriber() {
      useHostFanout(['https://host-i.example']);
      return null;
    }
    const container = renderWithHosts(
      <>
        <OtherHostProjects />
        <FanoutSubscriber />
      </>,
    );
    await settle();

    expect(container.textContent).toContain('repo-i');
    expect(state.hosts['https://host-i.example']?.capabilitiesCalls).toBe(1);
    expect(
      state.clientConstructs.filter(
        (opts) => opts.baseUrl === 'https://host-i.example',
      ).length,
    ).toBe(1);
  });

  it('focuses a CSP-covered host in-app instead of navigating', async () => {
    state.baseUrl = 'https://host-g.example';
    window.history.replaceState(
      {},
      '',
      '/?daemon=https%3A%2F%2Fhost-g.example&fanout=https%3A%2F%2Fhost-h.example',
    );
    rememberWorkspaceHost('https://host-g.example', []);
    rememberWorkspaceHost('https://host-h.example', []);
    registerHost('https://host-h.example', { workspaces: [] });
    registerHost(PAGE_ORIGIN, { workspaces: [] });
    const container = renderWithHosts(
      <DaemonTargetProvider>
        <OtherHostProjects />
      </DaemonTargetProvider>,
    );
    await settle();

    expect(container.textContent).toContain('Local');
    buttonWithText(container, 'host-h.example')?.click();
    expect(state.openHostedWorkspace).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('daemon')).toBe(
      'https://host-h.example',
    );
  });
});

describe('WorkspaceSection storageKey', () => {
  beforeEach(() => {
    localStorage.clear();
    registerHost(PAGE_ORIGIN, { workspaces: [] });
  });

  afterEach(() => {
    cleanupReact();
  });

  it('namespaces expansion preferences without touching single-host keys', () => {
    const workspace = {
      id: 'ws1',
      cwd: '/srv/shared',
      primary: true,
      trusted: true,
    };
    const sectionProps = {
      workspace,
      client: new DaemonClient({ baseUrl: PAGE_ORIGIN }),
      reloadToken: 0,
      untrustedLabel: 'Untrusted',
      readOnlyLabel: 'Read-only',
      trustToOpenLabel: 'Trust to open',
      noSessionsLabel: 'No sessions',
      loadErrorLabel: 'Load failed',
      organizationEnabled: false,
      channelGroupingEnabled: false,
      ungroupedLabel: 'Ungrouped',
      renderSession: () => null,
    };
    const container = mountReact(
      <I18nProvider language="en">
        <WorkspaceSection
          {...sectionProps}
          storageKey={'https://h.example\0ws1'}
        />
        <WorkspaceSection {...sectionProps} />
      </I18nProvider>,
    );
    const toggles = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    expect(toggles).toHaveLength(2);
    // Collapse only the host-namespaced section.
    toggles[0]?.click();
    const stored = Object.keys(localStorage).filter((key) =>
      key.startsWith('qwen.web-shell.sidebar.workspace-expanded:'),
    );
    expect(stored).toEqual([
      'qwen.web-shell.sidebar.workspace-expanded:https://h.example\0ws1',
    ]);
    expect(localStorage.getItem(stored[0] ?? '')).toBe('false');
    expect(toggles[1]?.getAttribute('aria-expanded')).toBe('true');
  });
});
