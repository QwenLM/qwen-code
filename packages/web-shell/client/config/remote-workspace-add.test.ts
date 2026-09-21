// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToDaemon = vi.hoisted(() => vi.fn());
const confirmDaemonTarget = vi.hoisted(() => vi.fn());
const getDaemonToken = vi.hoisted(() => vi.fn());
const getAllowedDaemonOrigin = vi.hoisted(() =>
  vi.fn((raw: string) => {
    try {
      const url = new URL(raw);
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.origin
        : '';
    } catch {
      return '';
    }
  }),
);

vi.mock('./daemon', () => ({
  confirmDaemonTarget,
  getAllowedDaemonOrigin,
  getDaemonToken,
  navigateToDaemon,
}));

const {
  addWorkspaceToDaemon,
  clearRemoteWorkspaceAddStep,
  completeRemoteWorkspaceAdd,
  discardAbandonedRemoteWorkspaceAdd,
  fetchRemotePathSuggestions,
  isRemoteWorkspaceAddActive,
  leaveRemoteWorkspaceAdd,
  selectRemoteWorkspaceLocation,
  startRemoteWorkspaceAdd,
} = await import('./remote-workspace-add');

const originalLocation = window.location;
const testOrigin = originalLocation.origin;
const assign = vi.fn();

function setLocation(href: string): void {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      assign,
    },
  });
}

beforeEach(() => {
  setLocation(`${testOrigin}/session/original?workspace=local#token=x`);
  navigateToDaemon.mockReturnValue(true);
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('remote workspace add navigation', () => {
  it('carries a one-shot browse request across a daemon switch', () => {
    expect(startRemoteWorkspaceAdd('https://remote.example', 'secret')).toBe(
      true,
    );

    expect(navigateToDaemon).toHaveBeenCalledWith(
      'https://remote.example',
      'secret',
      {
        continueFlow: 'workspace',
      },
    );
    expect(window.sessionStorage.getItem('qwen-remote-workspace-return')).toBe(
      `${testOrigin}/session/original?workspace=local`,
    );
  });

  it('switches folder sources without replacing the original return page', () => {
    expect(startRemoteWorkspaceAdd('https://remote.example')).toBe(true);
    setLocation(
      `${testOrigin}/?daemon=https%3A%2F%2Fremote.example&addRemoteWorkspace=browse`,
    );

    expect(selectRemoteWorkspaceLocation(testOrigin)).toBe(true);
    expect(navigateToDaemon).toHaveBeenLastCalledWith(testOrigin, undefined, {
      continueFlow: 'workspace',
    });
    expect(window.sessionStorage.getItem('qwen-remote-workspace-return')).toBe(
      `${testOrigin}/session/original?workspace=local`,
    );
  });

  it('reconfirms a remote daemon saved in the source page', () => {
    setLocation(
      `${testOrigin}/?daemon=https%3A%2F%2Forigin.example&workspace=source`,
    );
    expect(startRemoteWorkspaceAdd('https://target.example')).toBe(true);
    setLocation(
      `${testOrigin}/?daemon=https%3A%2F%2Ftarget.example&addRemoteWorkspace=browse`,
    );

    expect(leaveRemoteWorkspaceAdd()).toBe(true);
    expect(confirmDaemonTarget).toHaveBeenCalledWith('https://origin.example');
    expect(assign).toHaveBeenCalledWith(
      `${testOrigin}/?daemon=https%3A%2F%2Forigin.example&workspace=source`,
    );
  });

  it('removes flow state after a completed add', () => {
    window.history.replaceState(null, '', '/?addRemoteWorkspace=browse');
    window.sessionStorage.setItem(
      'qwen-remote-workspace-return',
      `${testOrigin}/session/original`,
    );

    completeRemoteWorkspaceAdd();

    expect(isRemoteWorkspaceAddActive()).toBe(false);
    expect(window.sessionStorage.getItem('qwen-remote-workspace-return')).toBe(
      null,
    );
  });

  it('drops a return location an abandoned hand-over left behind', () => {
    // A reload or the Back button abandons the flow: the marker is gone but the
    // key survives, and the next Cancel in any Add-workspace dialog — including
    // a purely local one — would consume that stale location.
    window.sessionStorage.setItem(
      'qwen-remote-workspace-return',
      `${testOrigin}/session/original`,
    );
    expect(isRemoteWorkspaceAddActive()).toBe(false);

    discardAbandonedRemoteWorkspaceAdd();

    expect(window.sessionStorage.getItem('qwen-remote-workspace-return')).toBe(
      null,
    );
    expect(leaveRemoteWorkspaceAdd()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('removes only the flow marker from the live URL', () => {
    setLocation(
      `${testOrigin}/session/current?daemon=https%3A%2F%2Fremote.example&addRemoteWorkspace=browse`,
    );
    const replaceState = vi.spyOn(window.history, 'replaceState');

    clearRemoteWorkspaceAddStep();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0]?.[2]?.toString()).toBe(
      `${testOrigin}/session/current?daemon=https%3A%2F%2Fremote.example`,
    );
  });

  it('reports the add flow inactive outside a document', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(isRemoteWorkspaceAddActive()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('remote daemon proxy calls', () => {
  const REMOTE = 'http://127.0.0.1:5199';

  /**
   * The proxy routes are relative URLs, so they are answered by the daemon that
   * served the page — while `?daemon=` names the *target*. The two credentials
   * are different and must not be swapped: `getDaemonToken` returns a distinct
   * token per argument and nothing at all for the no-argument form, so a call
   * that reads the connected daemon's token instead of the page origin's
   * cannot authenticate here.
   */
  function stubTokens(): void {
    getDaemonToken.mockImplementation((baseUrl?: string) => {
      if (baseUrl === testOrigin) return 'serving-secret';
      if (baseUrl === REMOTE) return 'target-secret';
      return undefined;
    });
  }

  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ dir: '/srv', sep: '/', suggestions: [] }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authenticates the path-suggestion proxy to the daemon serving it', async () => {
    setLocation(`${testOrigin}/?daemon=${encodeURIComponent(REMOTE)}`);
    stubTokens();
    const fetchMock = stubFetch();

    await fetchRemotePathSuggestions(REMOTE, '/srv/');

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(
      `/remote-workspace-path-suggestions?daemon=${encodeURIComponent(REMOTE)}&prefix=%2Fsrv%2F`,
    );
    expect(init.headers).toEqual({
      Authorization: 'Bearer serving-secret',
      'X-Daemon-Token': 'target-secret',
    });
  });

  it('authenticates the workspace-registration proxy to the daemon serving it', async () => {
    setLocation(`${testOrigin}/?daemon=${encodeURIComponent(REMOTE)}`);
    stubTokens();
    const fetchMock = stubFetch();

    await addWorkspaceToDaemon(REMOTE, '/srv/shared-checkout/', true, 'Shared');

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('/remote-workspaces');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer serving-secret',
      'X-Daemon-Token': 'target-secret',
    });
    expect(JSON.parse(init.body)).toEqual({
      daemon: REMOTE,
      cwd: '/srv/shared-checkout/',
      persist: true,
      displayName: 'Shared',
    });
  });

  it('sends no credential headers when neither daemon requires a token', async () => {
    setLocation(`${testOrigin}/?daemon=${encodeURIComponent(REMOTE)}`);
    getDaemonToken.mockReturnValue(undefined);
    const fetchMock = stubFetch();

    await fetchRemotePathSuggestions(REMOTE, '/srv/');

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers).toEqual({});
  });
});
