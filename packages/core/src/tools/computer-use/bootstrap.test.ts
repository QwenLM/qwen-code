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
  parseDoctorStdout,
  type BootstrapDeps,
} from './bootstrap.js';

function makeFakeClient(opts: { startThrows?: Error } = {}) {
  const start = vi.fn(async () => {
    if (opts.startThrows) throw opts.startThrows;
  });
  return {
    isStarted: vi.fn(() => start.mock.calls.length > 0),
    start,
    callTool: vi.fn(),
    stop: vi.fn(),
  };
}

describe('runBootstrap', () => {
  let tmpHome: string;
  let deps: BootstrapDeps;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'qwen-cu-bs-'));
    deps = {
      homeDir: tmpHome,
      packageSpec: 'open-computer-use@^0.3.0',
      platform: 'darwin',
      promptInstallApproval: vi.fn(async () => true),
      probePermissions: vi.fn(async () => 'ok' as const),
    };
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('starts the client when binary is approved + permissions ok', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(client.start).toHaveBeenCalledOnce();
    expect(deps.promptInstallApproval).not.toHaveBeenCalled();
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

  it('throws when user declines install', async () => {
    deps.promptInstallApproval = vi.fn(async () => false);
    const client = makeFakeClient();

    await expect(
      runBootstrap(
        client as never,
        { signal: new AbortController().signal },
        deps,
      ),
    ).rejects.toThrow(/declined/i);
    expect(client.start).not.toHaveBeenCalled();
  });

  it('persists approval on success', async () => {
    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    const { loadInstallState } = await import('./install-state.js');
    const state = await loadInstallState(tmpHome);
    expect(state?.approvedPackageSpec).toBe('open-computer-use@^0.3.0');
  });

  it('polls probePermissions when permissions are missing then granted', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    let probeCount = 0;
    deps.probePermissions = vi.fn(async () => {
      probeCount++;
      return probeCount < 3 ? 'accessibility' : 'ok';
    });
    deps.pollIntervalMs = 1; // speed up test
    deps.pollTimeoutMs = 1000;

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    // probe is called by bootstrap (each call is a doctor invocation in
    // production, but here it's a mock). Doctor itself launches the
    // onboarding window when needed — no separate spawnDoctor step.
    expect(probeCount).toBeGreaterThanOrEqual(3);
    expect(deps.probePermissions).toHaveBeenCalledWith(
      'open-computer-use@^0.3.0',
    );
  });

  it('throws after pollTimeoutMs when permissions never grant', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    deps.probePermissions = vi.fn(async () => 'accessibility' as const);
    deps.pollIntervalMs = 1;
    deps.pollTimeoutMs = 50;

    const client = makeFakeClient();
    await expect(
      runBootstrap(
        client as never,
        { signal: new AbortController().signal },
        deps,
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it('skips permission flow on non-darwin platforms', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    deps.platform = 'linux';

    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(deps.probePermissions).not.toHaveBeenCalled();
  });

  it('emits a fresh updateOutput message when permission kind changes mid-poll', async () => {
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    // Probe sequence: accessibility → screenRecording → ok
    let probeCount = 0;
    deps.probePermissions = vi.fn(async () => {
      probeCount++;
      if (probeCount === 1) return 'accessibility' as const;
      if (probeCount === 2) return 'screenRecording' as const;
      return 'ok' as const;
    });
    deps.pollIntervalMs = 1;
    deps.pollTimeoutMs = 1000;

    const messages: string[] = [];
    const client = makeFakeClient();
    await runBootstrap(
      client as never,
      {
        signal: new AbortController().signal,
        updateOutput: (msg) => messages.push(msg),
      },
      deps,
    );

    // The transition (accessibility → screenRecording) must emit a
    // user-facing message naming the new permission kind. LaunchServices
    // dedups doctor's window so we don't need a separate spawn step.
    expect(messages.some((m) => m.includes('screenRecording'))).toBe(true);
    expect(messages.some((m) => m.includes('accessibility'))).toBe(true);
  });

  it('skips permission probe when client is already started (no probe spam per tool call)', async () => {
    // Regression: bootstrap used to call probePermissions on EVERY
    // tool call (which in the previous Finder-based probe popped Finder
    // to the foreground each time). The wasAlreadyStarted check makes
    // probe fire only on a fresh client start.
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    const startSpy = vi.fn(async () => {});
    const client = {
      isStarted: vi.fn(() => true), // already started
      start: startSpy,
      callTool: vi.fn(),
      stop: vi.fn(),
    };

    await runBootstrap(
      client as never,
      { signal: new AbortController().signal },
      deps,
    );

    expect(startSpy).not.toHaveBeenCalled();
    expect(deps.probePermissions).not.toHaveBeenCalled();
  });
});

describe('parseDoctorStdout', () => {
  it("returns 'ok' when doctor reports both permissions granted", () => {
    const stdout =
      'Permissions: accessibility=granted, screenRecording=granted\n';
    expect(parseDoctorStdout(stdout)).toBe('ok');
  });

  it("returns 'accessibility' when accessibility is missing", () => {
    const stdout =
      'Permissions: accessibility=missing, screenRecording=granted\n';
    expect(parseDoctorStdout(stdout)).toBe('accessibility');
  });

  it("returns 'screenRecording' when only Screen Recording is missing", () => {
    const stdout =
      'Permissions: accessibility=granted, screenRecording=missing\n';
    expect(parseDoctorStdout(stdout)).toBe('screenRecording');
  });

  it("prefers 'accessibility' when both are missing (driven by doctor's onboarding order)", () => {
    const stdout =
      'Permissions: accessibility=missing, screenRecording=missing\n';
    expect(parseDoctorStdout(stdout)).toBe('accessibility');
  });

  it('parses case-insensitively and tolerates whitespace around `=`', () => {
    const stdout =
      'Permissions: Accessibility = Granted, ScreenRecording = Granted\n';
    expect(parseDoctorStdout(stdout)).toBe('ok');
  });

  it("returns 'accessibility' when stdout is empty (defensive: treat unknown as missing)", () => {
    // Defensive: if doctor produces no parseable output, assume the
    // worst (permissions missing) — better to over-prompt than to
    // silently proceed and have the tool call fail later.
    expect(parseDoctorStdout('')).toBe('accessibility');
  });
});
