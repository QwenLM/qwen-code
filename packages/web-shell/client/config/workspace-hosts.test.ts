// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readWorkspaceHosts, rememberWorkspaceHost } from './workspace-hosts';

describe('workspace host catalog', () => {
  beforeEach(() => localStorage.clear());

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
