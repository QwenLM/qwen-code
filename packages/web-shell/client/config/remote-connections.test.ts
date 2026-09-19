// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetRemoteConnection,
  isRemoteConnectionKnown,
  readRemoteConnections,
  rememberRemoteConnection,
} from './remote-connections';

describe('remote connections', () => {
  beforeEach(() => {
    window.localStorage.clear();
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

  it('forgets a connection', () => {
    rememberRemoteConnection('https://one.example');
    rememberRemoteConnection('https://two.example');

    expect(forgetRemoteConnection('https://one.example')).toEqual([
      'https://two.example',
    ]);
    expect(isRemoteConnectionKnown('https://one.example')).toBe(false);
  });
});
