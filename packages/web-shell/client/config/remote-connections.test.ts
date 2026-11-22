// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetRemoteConnection,
  formatOriginHost,
  isRemoteConnectionKnown,
  readRemoteConnections,
  rememberRemoteConnection,
} from './remote-connections';
import { readWorkspaceHosts, rememberWorkspaceHost } from './workspace-hosts';

describe('remote connections', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('remembers normalized remote origins without duplicates', () => {
    rememberRemoteConnection('https://remote.example');
    rememberRemoteConnection('https://remote.example');

    expect(readRemoteConnections()).toEqual(['https://remote.example']);
    expect(isRemoteConnectionKnown('https://remote.example')).toBe(true);
  });

  it('does not catalog this computer or invalid addresses', () => {
    rememberRemoteConnection(window.location.origin);
    rememberRemoteConnection('not a daemon');

    expect(readRemoteConnections()).toEqual([]);
  });

  it('filters malformed stored values', () => {
    window.localStorage.setItem(
      'qwen-remote-connections',
      JSON.stringify([
        'https://remote.example',
        'https://remote.example/path',
        42,
      ]),
    );

    expect(readRemoteConnections()).toEqual(['https://remote.example']);
  });

  it('keeps an invalid display origin from breaking render paths', () => {
    expect(formatOriginHost('//remote.example')).toBe('//remote.example');
  });

  it('forgets a connection', () => {
    rememberRemoteConnection('https://one.example');
    rememberRemoteConnection('https://two.example');

    expect(forgetRemoteConnection('https://one.example')).toEqual([
      'https://two.example',
    ]);
    expect(isRemoteConnectionKnown('https://one.example')).toBe(false);
  });

  it('forgetting a connection also clears its workspace catalog, token, and notifies listeners', () => {
    rememberRemoteConnection('https://one.example');
    rememberWorkspaceHost('https://one.example', [
      { id: 'ws-1', cwd: '/repo/one' },
    ]);
    rememberWorkspaceHost('https://two.example', [
      { id: 'ws-2', cwd: '/repo/two' },
    ]);
    window.sessionStorage.setItem(
      'qwen-daemon-token:https://one.example',
      'tok-one',
    );
    const events: string[] = [];
    window.addEventListener('qwen-remote-connections', () =>
      events.push('connections'),
    );
    window.addEventListener('qwen-workspace-hosts', () =>
      events.push('workspace-hosts'),
    );

    forgetRemoteConnection('https://one.example');

    // The fan-out group unions both catalogs, so a removal must clear both —
    // otherwise the host would stay listed in the same tab.
    expect(readRemoteConnections()).toEqual([]);
    expect(
      readWorkspaceHosts().find(
        (host) => host.origin === 'https://one.example',
      ),
    ).toBeUndefined();
    expect(
      readWorkspaceHosts().find((host) => host.origin === 'https://two.example')
        ?.workspaces[0]?.cwd,
    ).toBe('/repo/two');
    expect(
      window.sessionStorage.getItem('qwen-daemon-token:https://one.example'),
    ).toBeNull();
    expect(events).toContain('connections');
    expect(events).toContain('workspace-hosts');
  });
});
