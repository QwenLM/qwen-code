/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBootstrap,
  parsePermissionsStatus,
  type BootstrapDeps,
  type StatusDaemon,
} from './bootstrap.js';

const KEY = 'cua-driver-rs@0.5.2';

function makeFakeClient() {
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  return {
    isStarted: vi.fn(() => start.mock.calls.length > stop.mock.calls.length),
    start,
    stop,
    callTool: vi.fn(),
  };
}

describe('runBootstrap', () => {
  let tmpHome: string;
  let daemon: StatusDaemon & { kill: ReturnType<typeof vi.fn> };
  let deps: BootstrapDeps;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'qwen-cu-bs-'));
    daemon = { kill: vi.fn() };
    deps = {
      homeDir: tmpHome,
      approvalKey: KEY,
      platform: 'darwin',
      promptInstallApproval: vi.fn(async () => true),
      install: vi.fn(async () => '/fake/cua-driver'),
      startStatusDaemon: vi.fn(() => daemon),
      probePermissions: vi.fn(async () => 'ok' as const),
      openPermissionPane: vi.fn(),
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
    };
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('starts the proxy directly when already granted (no panes opened)', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: KEY,
      approvedAtIso: '2026-06-12T10:00:00Z',
    });

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(deps.install).toHaveBeenCalledOnce();
    expect(deps.openPermissionPane).not.toHaveBeenCalled();
    expect(daemon.kill).toHaveBeenCalled(); // status daemon torn down
    expect(client.start).toHaveBeenCalledOnce();
  });

  it('prompts for install approval on first call', async () => {
    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );
    expect(deps.promptInstallApproval).toHaveBeenCalledOnce();
    expect(client.start).toHaveBeenCalledOnce();
  });

  it('throws and does NOT download when user declines install', async () => {
    deps.promptInstallApproval = vi.fn(async () => false);
    const client = makeFakeClient();
    await expect(
      runBootstrap(
        client as never,
        { signal: new AbortController().signal },
        deps,
      ),
    ).rejects.toThrow(/declined/i);
    expect(deps.install).not.toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it('auto-approves the install (no prompt) and persists state when autoApproveInstall is set', async () => {
    // review #1 (⑤): an auto-approve mode or an always-allow-ruled call passes
    // autoApproveInstall. The gate must skip promptInstallApproval, persist the
    // install state (so later cold calls also skip the gate), and proceed —
    // this is what closes the DEFAULT-mode "install declined" dead-end.
    const { isPackageSpecApproved } = await import('./install-state.js');
    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal, autoApproveInstall: true },
      deps,
    );
    expect(deps.promptInstallApproval).not.toHaveBeenCalled();
    expect(await isPackageSpecApproved(tmpHome, KEY)).toBe(true);
    expect(deps.install).toHaveBeenCalledOnce();
    expect(client.start).toHaveBeenCalledOnce();
  });

  it('guides one permission at a time: Accessibility pane, then Screen Recording pane', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: KEY,
      approvedAtIso: '2026-06-12T10:00:00Z',
    });

    // accessibility missing → screen recording missing → ok
    let n = 0;
    deps.probePermissions = vi.fn(async () => {
      n++;
      if (n === 1) return 'accessibility' as const;
      if (n === 2) return 'screenRecording' as const;
      return 'ok' as const;
    });

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    const panes = (deps.openPermissionPane as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(panes).toEqual([['accessibility'], ['screenRecording']]); // in order, one each
    expect(client.start).toHaveBeenCalledOnce();
  });

  it('relaunches the status daemon when status reads unknown (e.g. SR restart)', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: KEY,
      approvedAtIso: '2026-06-12T10:00:00Z',
    });

    let n = 0;
    deps.probePermissions = vi.fn(async () => {
      n++;
      if (n === 1) return 'unknown' as const; // daemon coming up / restarted
      if (n === 2) return 'accessibility' as const;
      return 'ok' as const;
    });

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    // initial launch + one relaunch after 'unknown'.
    expect(deps.startStatusDaemon).toHaveBeenCalledTimes(2);
    expect(client.start).toHaveBeenCalledOnce();
  });

  it('times out (and tears down the daemon) if permissions never arrive', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: KEY,
      approvedAtIso: '2026-06-12T10:00:00Z',
    });
    deps.probePermissions = vi.fn(async () => 'accessibility' as const);
    deps.pollTimeoutMs = 30;

    const client = makeFakeClient();
    await expect(
      runBootstrap(
        client as never,
        { signal: new AbortController().signal },
        deps,
      ),
    ).rejects.toThrow(/timed out/i);
    expect(daemon.kill).toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it('skips the permission flow on non-darwin platforms', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: KEY,
      approvedAtIso: '2026-06-12T10:00:00Z',
    });
    deps.platform = 'linux';

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );
    expect(deps.startStatusDaemon).not.toHaveBeenCalled();
    expect(deps.probePermissions).not.toHaveBeenCalled();
    expect(client.start).toHaveBeenCalledOnce();
  });

  it('does nothing extra when the client is already started (warm)', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: KEY,
      approvedAtIso: '2026-06-12T10:00:00Z',
    });
    const client = {
      isStarted: vi.fn(() => true),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      callTool: vi.fn(),
    };
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );
    expect(client.start).not.toHaveBeenCalled();
    expect(deps.startStatusDaemon).not.toHaveBeenCalled();
    // The warm-client short-circuit must precede the install step: a started
    // client implies the binary is present, so the downloader must NOT run
    // (otherwise unit tests trigger a real ~20MB download). (review round 1)
    expect(deps.install).not.toHaveBeenCalled();
  });
});

describe('parsePermissionsStatus', () => {
  it("returns 'ok' when both grants are true", () => {
    expect(
      parsePermissionsStatus('{"accessibility":true,"screen_recording":true}'),
    ).toBe('ok');
  });
  it("returns 'accessibility' when accessibility is false", () => {
    expect(
      parsePermissionsStatus('{"accessibility":false,"screen_recording":true}'),
    ).toBe('accessibility');
  });
  it("returns 'screenRecording' when only screen recording is false", () => {
    expect(
      parsePermissionsStatus('{"accessibility":true,"screen_recording":false}'),
    ).toBe('screenRecording');
  });
  it("returns 'unknown' for daemon-less / unparseable payloads", () => {
    expect(parsePermissionsStatus('{"status":"unknown"}')).toBe('unknown');
    expect(parsePermissionsStatus('not json')).toBe('unknown');
  });
});
