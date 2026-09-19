// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToDaemon = vi.hoisted(() => vi.fn());
const confirmDaemonTarget = vi.hoisted(() => vi.fn());
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
  navigateToDaemon,
}));

const {
  clearRemoteWorkspaceAddStep,
  completeRemoteWorkspaceAdd,
  discardAbandonedRemoteWorkspaceAdd,
  getRemoteWorkspaceAddStep,
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
        continueRemoteWorkspaceAdd: true,
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
      continueRemoteWorkspaceAdd: true,
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

    expect(getRemoteWorkspaceAddStep()).toBeUndefined();
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
    expect(getRemoteWorkspaceAddStep()).toBeUndefined();

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

  it('reports no step for an entry point evaluated outside a document', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(getRemoteWorkspaceAddStep()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
