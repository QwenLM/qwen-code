// @vitest-environment jsdom
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

  it('prefers the desktop copy and drops a stale origin copy', async () => {
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
      '["https://stale.example"]',
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

  it('writes through to the desktop store', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => null);
    installDesktop(invoke);

    const { readShellState, writeShellState } = await import('./shell-state');
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
});
