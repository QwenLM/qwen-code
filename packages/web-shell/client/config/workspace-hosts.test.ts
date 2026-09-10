// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkspaceReturnUrl,
  readWorkspaceHosts,
  rememberWorkspaceHost,
} from './workspace-hosts';

describe('workspace host catalog', () => {
  beforeEach(() => localStorage.clear());

  it('does not notify or reorder hosts on an unchanged refresh', () => {
    rememberWorkspaceHost('https://first.example', []);
    rememberWorkspaceHost('https://second.example', []);
    const listener = vi.fn();
    window.addEventListener('qwen-workspace-hosts', listener);
    try {
      rememberWorkspaceHost('https://first.example', []);
      expect(listener).not.toHaveBeenCalled();
      expect(readWorkspaceHosts()[0].origin).toBe('https://first.example');
    } finally {
      window.removeEventListener('qwen-workspace-hosts', listener);
    }
  });

  it('returns to the original session without credentials and rejects external return targets', () => {
    const original = window.location.href;
    const url = new URL(original);
    const session = new URL(
      '/session/original?workspace=remote&token=secret#token=secret',
      url,
    );
    url.searchParams.set('workspaceReturn', session.toString());
    window.history.replaceState(null, '', url);
    try {
      expect(getWorkspaceReturnUrl()).toBe(
        new URL('/session/original?workspace=remote', url).toString(),
      );
      url.searchParams.set('workspaceReturn', 'https://other.example/session');
      window.history.replaceState(null, '', url);
      expect(getWorkspaceReturnUrl()).toBeUndefined();
    } finally {
      window.history.replaceState(null, '', original);
    }
  });

  it('keeps identical directory paths on separate hosts and replaces only the refreshed host', () => {
    rememberWorkspaceHost('http://localhost:5273', [
      { id: 'local', cwd: '/repo' },
    ]);
    rememberWorkspaceHost('https://remote.example', [
      { id: 'remote', cwd: '/repo' },
    ]);
    rememberWorkspaceHost('https://remote.example', [
      { id: 'remote-2', cwd: '/repo-2' },
    ]);
    expect(readWorkspaceHosts()).toEqual([
      {
        origin: 'http://localhost:5273',
        workspaces: [{ id: 'local', cwd: '/repo' }],
      },
      {
        origin: 'https://remote.example',
        workspaces: [{ id: 'remote-2', cwd: '/repo-2' }],
      },
    ]);
  });

  it('ignores malformed or credential-bearing saved targets', () => {
    localStorage.setItem(
      'qwen-workspace-hosts',
      JSON.stringify([
        { origin: 'https://user:password@remote.example', workspaces: [] },
        { origin: 'https://remote.example', workspaces: [{ id: 4 }] },
      ]),
    );
    expect(readWorkspaceHosts()).toEqual([]);
  });
});
