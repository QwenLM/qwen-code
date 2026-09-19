// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToDaemon = vi.hoisted(() => vi.fn());
const confirmDaemonTarget = vi.hoisted(() => vi.fn());
const persistDaemonToken = vi.hoisted(() => vi.fn());
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
  getDaemonBaseUrl: () => '',
  navigateToDaemon,
  persistDaemonToken,
}));

const {
  clearInitialConnectionsSettingsCategory,
  completeRemoteConnectionAdd,
  forgetRemoteConnection,
  getInitialConnectionsSettingsCategory,
  isRemoteConnectionAddActive,
  leaveRemoteConnectionAdd,
  readRemoteConnections,
  rememberRemoteConnection,
  startRemoteConnectionAdd,
} = await import('./remote-connections');

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
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
  window.history.replaceState(null, '', '/');
  vi.clearAllMocks();
});

describe('remote connection add navigation', () => {
  it('verifies a new connection through the selected daemon', () => {
    expect(startRemoteConnectionAdd('https://remote.example', 'secret')).toBe(
      true,
    );

    expect(navigateToDaemon).toHaveBeenCalledWith(
      'https://remote.example',
      'secret',
      { continueRemoteConnectionAdd: true },
    );
    expect(window.sessionStorage.getItem('qwen-remote-connection-return')).toBe(
      `${testOrigin}/session/original?workspace=local`,
    );
  });

  it('remembers a verified connection and returns to Connections settings', () => {
    window.sessionStorage.setItem(
      'qwen-remote-connection-return',
      `${testOrigin}/session/original?workspace=local`,
    );
    setLocation(
      `${testOrigin}/?daemon=https%3A%2F%2Fremote.example&addRemoteConnection=verify`,
    );

    expect(isRemoteConnectionAddActive()).toBe(true);
    expect(completeRemoteConnectionAdd('https://remote.example')).toBe(true);
    expect(readRemoteConnections()).toEqual(['https://remote.example']);
    expect(assign).toHaveBeenCalledWith(
      `${testOrigin}/session/original?workspace=local&settings=Connections`,
    );
    expect(confirmDaemonTarget).toHaveBeenCalledWith(testOrigin);
  });

  it('cancels back to Connections without remembering the target', () => {
    window.sessionStorage.setItem(
      'qwen-remote-connection-return',
      `${testOrigin}/session/original`,
    );
    setLocation(`${testOrigin}/?addRemoteConnection=verify`);

    expect(leaveRemoteConnectionAdd()).toBe(true);
    expect(readRemoteConnections()).toEqual([]);
    expect(assign).toHaveBeenCalledWith(
      `${testOrigin}/session/original?settings=Connections`,
    );
  });

  it('clears an orphaned verification marker and keeps the verified origin', () => {
    setLocation(`${testOrigin}/?addRemoteConnection=verify`);
    const replaceState = vi.spyOn(window.history, 'replaceState');

    expect(completeRemoteConnectionAdd('https://remote.example')).toBe(false);
    expect(readRemoteConnections()).toEqual(['https://remote.example']);
    expect(replaceState.mock.calls[0]?.[2]?.toString()).toBe(`${testOrigin}/`);
  });

  it('opens Connections once and removes its URL marker', () => {
    setLocation(`${testOrigin}/?workspace=local&settings=Connections`);

    expect(getInitialConnectionsSettingsCategory()).toBe('Connections');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    clearInitialConnectionsSettingsCategory();

    expect(replaceState.mock.calls[0]?.[2]?.toString()).toBe(
      `${testOrigin}/?workspace=local`,
    );
  });

  it('forgets the origin and its tab-scoped token together', () => {
    rememberRemoteConnection('https://remote.example');

    expect(forgetRemoteConnection('https://remote.example')).toEqual([]);
    expect(persistDaemonToken).toHaveBeenCalledWith(
      '',
      'https://remote.example',
    );
  });
});
