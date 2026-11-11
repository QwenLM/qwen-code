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

/** The mirror, stamp and optional native base a launch leaves behind. */
function seedMirror(
  key: string,
  value: string,
  launch = 'launch-nonce',
  base?: string,
): void {
  window.localStorage.setItem(key, value);
  window.localStorage.setItem(`qwen-shell-mirror-launch:${key}`, launch);
  if (base !== undefined) {
    window.localStorage.setItem(`qwen-shell-mirror-base:${key}`, base);
  }
}

describe('desktop shell state', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.sessionStorage.clear();
    // The desktop boot URL carries this beside `token=`; the shell passes it on
    // every shell_state_* call.
    window.history.replaceState(null, '', '/#token=secret&shell=launch-nonce');
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  });

  afterEach(() => {
    delete (window as { __TAURI__?: unknown }).__TAURI__;
    window.history.replaceState(null, '', '/');
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
      nonce: 'launch-nonce',
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
    seedMirror('qwen-remote-connections', '[]');

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe('[]');
    expect(window.localStorage.getItem('qwen-remote-connections')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('shell_state_write', {
      key: 'qwen-remote-connections',
      value: '[]',
      nonce: 'launch-nonce',
    });
  });

  it('re-pushes an earlier-launch mirror whose recorded base still matches native', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        return args?.['key'] === 'qwen-remote-connections'
          ? '["https://a.example"]'
          : null;
      },
    );
    installDesktop(invoke);
    // The write that produced this mirror never landed natively, and the
    // catalog has not moved past the base the mirror records: the mirror is
    // the only surviving copy of the newer value, not a stale one.
    seedMirror(
      'qwen-remote-connections',
      '["https://a.example","https://b.example"]',
      'earlier-launch',
      '["https://a.example"]',
    );

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://a.example","https://b.example"]',
    );
    expect(invoke).toHaveBeenCalledWith('shell_state_write', {
      key: 'qwen-remote-connections',
      value: '["https://a.example","https://b.example"]',
      nonce: 'launch-nonce',
    });
  });

  it('keeps the native catalog when an earlier-launch mirror has a stale base', async () => {
    const invoke = vi.fn(
      async (command: string): Promise<unknown> =>
        command === 'shell_state_read' ? '["https://new.example"]' : undefined,
    );
    installDesktop(invoke);
    // An ephemeral port came back around: this origin still holds the mirror a
    // previous launch wrote, and the catalog has moved past its base since.
    seedMirror(
      'qwen-remote-connections',
      '["https://old.example"]',
      'earlier-launch',
      '["https://base.example"]',
    );

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://new.example"]',
    );
    expect(window.localStorage.getItem('qwen-remote-connections')).toBeNull();
    // The mirror's metadata must not outlive the mirror itself.
    expect(
      window.localStorage.getItem(
        'qwen-shell-mirror-base:qwen-remote-connections',
      ),
    ).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      'shell_state_write',
      expect.objectContaining({ key: 'qwen-remote-connections' }),
    );
  });

  it('keeps the native catalog when an earlier-launch mirror has no recorded base', async () => {
    const invoke = vi.fn(
      async (command: string): Promise<unknown> =>
        command === 'shell_state_read' ? '["https://new.example"]' : undefined,
    );
    installDesktop(invoke);
    // A mirror written before the base record existed keeps the older
    // behaviour: with a native value present it is dropped.
    seedMirror(
      'qwen-remote-connections',
      '["https://old.example"]',
      'earlier-launch',
    );

    const { hydrateShellState, readShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(readShellState('qwen-remote-connections')).toBe(
      '["https://new.example"]',
    );
    expect(window.localStorage.getItem('qwen-remote-connections')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      'shell_state_write',
      expect.objectContaining({ key: 'qwen-remote-connections' }),
    );
  });

  it('keeps the mirror when re-pushing it is rejected', async () => {
    const invoke = vi.fn(async (command: string): Promise<unknown> => {
      if (command === 'shell_state_read') return '["https://old.example"]';
      throw new Error(
        'Desktop shell state value for qwen-remote-connections exceeds 262144 bytes',
      );
    });
    installDesktop(invoke);
    seedMirror('qwen-remote-connections', '["https://new.example"]');

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
      nonce: 'launch-nonce',
    });
  });

  it('sends the launch nonce with every shell-state call', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => null);
    installDesktop(invoke);

    const { hydrateShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(invoke).toHaveBeenCalledWith('shell_state_read', {
      key: 'qwen-remote-connections',
      nonce: 'launch-nonce',
    });
    expect(invoke).toHaveBeenCalledWith('shell_state_read', {
      key: 'qwen-workspace-hosts',
      nonce: 'launch-nonce',
    });
  });

  it('stamps the mirror it writes with this launch', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => null);
    installDesktop(invoke);

    const { hydrateShellState, writeShellState } = await import(
      './shell-state'
    );
    await hydrateShellState();
    writeShellState('qwen-remote-connections', '["https://new.example"]');

    expect(window.localStorage.getItem('qwen-remote-connections')).toBe(
      '["https://new.example"]',
    );
    // Without this stamp the next hydration would treat the mirror as an
    // earlier launch's copy and drop it instead of re-pushing it.
    expect(
      window.localStorage.getItem(
        'qwen-shell-mirror-launch:qwen-remote-connections',
      ),
    ).toBe('launch-nonce');
  });

  it('records the pre-write cache value as the base, not the value written', async () => {
    let native = '["https://a.example"]';
    let rejectWrites = false;
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'shell_state_read') return native;
        if (command === 'shell_state_write') {
          if (rejectWrites) throw new Error('write rejected');
          native = args?.['value'] as string;
        }
        return undefined;
      },
    );
    installDesktop(invoke);

    const first = await import('./shell-state');
    await first.hydrateShellState();
    // The first write lands natively; the second is rejected.
    first.writeShellState(
      'qwen-remote-connections',
      '["https://a.example","https://b.example"]',
    );
    rejectWrites = true;
    first.writeShellState(
      'qwen-remote-connections',
      '["https://a.example","https://b.example","https://c.example"]',
    );
    await Promise.resolve();

    // The base is what the cache held before the rejected write — the value
    // that landed natively — not the rejected value itself.
    expect(
      window.localStorage.getItem(
        'qwen-shell-mirror-base:qwen-remote-connections',
      ),
    ).toBe('["https://a.example","https://b.example"]');

    // The next launch reuses the origin: only the first write landed, so the
    // mirror is the only surviving copy of the second and must be adopted.
    vi.resetModules();
    window.history.replaceState(null, '', '/#token=secret&shell=launch-two');
    const secondInvoke = vi.fn(
      async (command: string): Promise<unknown> =>
        command === 'shell_state_read' ? native : undefined,
    );
    installDesktop(secondInvoke);

    const second = await import('./shell-state');
    await second.hydrateShellState();

    expect(second.readShellState('qwen-remote-connections')).toBe(
      '["https://a.example","https://b.example","https://c.example"]',
    );
    expect(secondInvoke).toHaveBeenCalledWith('shell_state_write', {
      key: 'qwen-remote-connections',
      value: '["https://a.example","https://b.example","https://c.example"]',
      nonce: 'launch-two',
    });
  });

  it('does not let a sibling catalog make an older mirror look current', async () => {
    // Launch 1: the saved-connection read fails, so its older mirror stays
    // while the workspace-host catalog hydrates and is then written.
    const firstInvoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        if (args?.['key'] === 'qwen-remote-connections') {
          throw new Error('ipc unavailable');
        }
        return null;
      },
    );
    installDesktop(firstInvoke);
    seedMirror(
      'qwen-remote-connections',
      '["https://stale.example"]',
      'earlier-launch',
    );

    const first = await import('./shell-state');
    await first.hydrateShellState();
    first.writeShellState('qwen-workspace-hosts', '[]');
    await Promise.resolve();

    // Same-origin reload: the failed key now reads, and it differs from the
    // mirror the earlier launch left behind.
    vi.resetModules();
    const secondInvoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        return args?.['key'] === 'qwen-remote-connections'
          ? '["https://native.example"]'
          : null;
      },
    );
    installDesktop(secondInvoke);

    const second = await import('./shell-state');
    await second.hydrateShellState();

    expect(second.readShellState('qwen-remote-connections')).toBe(
      '["https://native.example"]',
    );
    expect(window.localStorage.getItem('qwen-remote-connections')).toBeNull();
    expect(secondInvoke).not.toHaveBeenCalledWith(
      'shell_state_write',
      expect.objectContaining({ key: 'qwen-remote-connections' }),
    );
  });

  it('keeps the launch nonce across a reload that drops the fragment', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => null);
    installDesktop(invoke);
    const first = await import('./shell-state');
    await first.hydrateShellState();

    // An in-app navigation can land on a URL without the fragment; this
    // origin's session storage still holds the value.
    vi.resetModules();
    window.history.replaceState(null, '', '/');
    invoke.mockClear();

    const second = await import('./shell-state');
    await second.hydrateShellState();

    expect(invoke).toHaveBeenCalledWith('shell_state_read', {
      key: 'qwen-remote-connections',
      nonce: 'launch-nonce',
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
    // Comments carry quoted words too, so they are dropped before the parse:
    // a commented-out key must not count as an allowlisted one.
    const slice = rust
      .slice(start, rust.indexOf('];', start))
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const rustKeys = [...slice.matchAll(/"([^"]+)"/g)].map(([, key]) => key);

    const { SHELL_STATE_KEYS } = await import('./shell-state');
    expect([...rustKeys].sort()).toEqual([...SHELL_STATE_KEYS].sort());
  });

  it('reads the fragment key the desktop boot URL writes', async () => {
    const runtimePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../desktop/src-tauri/src/runtime.rs',
    );
    const runtime = readFileSync(runtimePath, 'utf8');
    // The Rust side owns the spelling; the read above must match it.
    expect(runtime).toContain('"token={}&shell={}"');

    window.history.replaceState(null, '', '/#shell=from-boot');
    const invoke = vi.fn(async (): Promise<unknown> => null);
    installDesktop(invoke);

    const { hydrateShellState } = await import('./shell-state');
    await hydrateShellState();

    expect(invoke).toHaveBeenCalledWith('shell_state_read', {
      key: 'qwen-remote-connections',
      nonce: 'from-boot',
    });
  });
});
