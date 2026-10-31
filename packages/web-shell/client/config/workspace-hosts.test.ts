// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceHosts, rememberWorkspaceHost } from './workspace-hosts';

describe('workspace host catalog', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('persists the page origin as the local offline snapshot in the browser', () => {
    rememberWorkspaceHost(window.location.origin, [
      { id: 'local', cwd: '/repo' },
    ]);

    expect(readWorkspaceHosts()).toEqual([
      {
        origin: window.location.origin,
        workspaces: [{ id: 'local', cwd: '/repo' }],
      },
    ]);
  });

  it('does not persist the page origin in the desktop shell', () => {
    (window as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: vi.fn() },
    };
    try {
      rememberWorkspaceHost(window.location.origin, [
        { id: 'local', cwd: '/repo' },
      ]);

      expect(readWorkspaceHosts()).toEqual([]);
    } finally {
      delete (window as { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it('persists a remote host through the desktop store', () => {
    const invoke = vi.fn(async (): Promise<unknown> => undefined);
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    try {
      rememberWorkspaceHost('https://remote.example', [
        { id: 'remote', cwd: '/repo' },
      ]);

      expect(readWorkspaceHosts()).toEqual([
        {
          origin: 'https://remote.example',
          workspaces: [{ id: 'remote', cwd: '/repo' }],
        },
      ]);
      expect(invoke).toHaveBeenCalledWith('shell_state_write', {
        key: 'qwen-workspace-hosts',
        value: expect.stringContaining('https://remote.example'),
      });
    } finally {
      delete (window as { __TAURI__?: unknown }).__TAURI__;
    }
  });

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

  it('persists identity fields only, dropping capability payloads and credentials', () => {
    rememberWorkspaceHost('https://remote.example', [
      {
        id: 'ws1',
        cwd: '/repo',
        displayName: 'Repo',
        // Extra capability fields must not reach localStorage.
        trusted: true,
        primary: true,
        ssh: { host: '10.0.0.1', directory: '/repo' },
      } as never,
    ]);
    expect(readWorkspaceHosts()).toEqual([
      {
        origin: 'https://remote.example',
        workspaces: [{ id: 'ws1', cwd: '/repo', displayName: 'Repo' }],
      },
    ]);
    expect(localStorage.getItem('qwen-workspace-hosts')).not.toContain(
      '10.0.0.1',
    );
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
