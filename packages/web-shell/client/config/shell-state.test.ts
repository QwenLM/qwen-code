// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function installDesktop(invoke: Invoke): void {
  (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
}

describe('desktop shell state', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  });

  afterEach(() => {
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  });

  it('migrates the current origin catalog into the desktop store', async () => {
    const invoke = vi.fn(
      async (command: string): Promise<unknown> =>
        command === 'shell_state_read' ? null : undefined,
    );
    installDesktop(invoke);
    window.localStorage.setItem(
      'qwen-remote-connections',
      '["https://remote.example"]',
    );

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://remote.example"]',
    );
    expect(window.localStorage.getItem('qwen-remote-connections')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('shell_state_write', {
      key: 'qwen-remote-connections',
      value: '["https://remote.example"]',
    });
  });

  it('drops a mirror that already matches the native copy', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        return args?.['key'] === 'qwen-remote-connections'
          ? '["https://native.example"]'
          : null;
      },
    );
    installDesktop(invoke);
    window.localStorage.setItem(
      'qwen-remote-connections',
      '["https://native.example"]',
    );

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://native.example"]',
    );
    expect(window.localStorage.getItem('qwen-remote-connections')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      'shell_state_write',
      expect.objectContaining({ key: 'qwen-remote-connections' }),
    );
  });

  it('re-pushes a newer mirror instead of restoring the stale native copy', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        return args?.['key'] === 'qwen-remote-connections'
          ? '["https://old.example"]'
          : null;
      },
    );
    installDesktop(invoke);
    // The mirror only ever differs after a native write that silently did not
    // land, so it is the surviving copy of the newer value.
    window.localStorage.setItem('qwen-remote-connections', '[]');

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe('[]');
    expect(window.localStorage.getItem('qwen-remote-connections')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('shell_state_write', {
      key: 'qwen-remote-connections',
      value: '[]',
    });
  });

  it('keeps the mirror when re-pushing it is rejected', async () => {
    const invoke = vi.fn(async (command: string): Promise<unknown> => {
      if (command === 'shell_state_read') return '["https://old.example"]';
      throw new Error(
        'Desktop shell state value for qwen-remote-connections exceeds 262144 bytes',
      );
    });
    installDesktop(invoke);
    window.localStorage.setItem(
      'qwen-remote-connections',
      '["https://new.example"]',
    );

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(window.localStorage.getItem('qwen-remote-connections')).toBe(
      '["https://new.example"]',
    );
    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://new.example"]',
    );
  });

  it('falls back to localStorage when the desktop read rejects', async () => {
    const invoke = vi.fn(async (command: string): Promise<unknown> => {
      if (command === 'shell_state_read') throw new Error('ipc unavailable');
      return undefined;
    });
    installDesktop(invoke);
    window.localStorage.setItem(
      'qwen-remote-connections',
      '["https://local.example"]',
    );

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://local.example"]',
    );
    expect(window.localStorage.getItem('qwen-remote-connections')).toBe(
      '["https://local.example"]',
    );
  });

  it('writes through to the desktop store after hydration', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => null);
    installDesktop(invoke);

    const { hydrateShellState, readShellState, writeShellState } = await import(
      './shell-state'
    );
    await hydrateShellState();
    writeShellState('qwen-workspace-hosts', '[]');

    expect(readShellState('qwen-workspace-hosts')).toBe('[]');
    expect(invoke).toHaveBeenCalledWith('shell_state_write', {
      key: 'qwen-workspace-hosts',
      value: '[]',
    });
  });

  it('feeds the saved-connection catalog from the desktop store', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        return args?.['key'] === 'qwen-remote-connections'
          ? '["https://native.example"]'
          : null;
      },
    );
    installDesktop(invoke);

    const { hydrateShellState } = await import('./shell-state');
    await hydrateShellState();
    const { readRemoteConnections } = await import('./remote-connections');

    expect(readRemoteConnections()).toEqual(['https://native.example']);
  });

  it('feeds the workspace-host catalog from the desktop store', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        return args?.['key'] === 'qwen-workspace-hosts'
          ? '[{"origin":"https://native.example","workspaces":[{"id":"w1","cwd":"/srv/repo"}]}]'
          : null;
      },
    );
    installDesktop(invoke);

    const { hydrateShellState } = await import('./shell-state');
    await hydrateShellState();
    const { readWorkspaceHosts } = await import('./workspace-hosts');

    expect(readWorkspaceHosts()).toEqual([
      {
        origin: 'https://native.example',
        workspaces: [{ id: 'w1', cwd: '/srv/repo' }],
      },
    ]);
  });

  it('keeps localStorage as the browser store', async () => {
    const { hydrateShellState, readShellState, writeShellState } = await import(
      './shell-state'
    );

    await hydrateShellState();
    writeShellState('qwen-remote-connections', '["https://remote.example"]');

    expect(window.localStorage.getItem('qwen-remote-connections')).toBe(
      '["https://remote.example"]',
    );
    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://remote.example"]',
    );
  });

  it('keeps the shell-state key list in sync with the Rust allowlist', async () => {
    const rustPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../desktop/src-tauri/src/desktop_state.rs',
    );
    const rust = readFileSync(rustPath, 'utf8');
    const start = rust.indexOf('pub const SHELL_STATE_KEYS');
    expect(start).toBeGreaterThanOrEqual(0);
    const slice = rust.slice(start, rust.indexOf('];', start));
    const rustKeys = [...slice.matchAll(/"([^"]+)"/g)].map(([, key]) => key);

    const { SHELL_STATE_KEYS } = await import('./shell-state');
    expect([...rustKeys].sort()).toEqual([...SHELL_STATE_KEYS].sort());
  });
});
