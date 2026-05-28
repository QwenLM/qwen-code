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
  probeFinderPermissions,
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
      spawnDoctor: vi.fn(),
      probePermissions: vi.fn(async () => 'ok' as const),
    };
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('starts the client when binary is approved + permissions ok', async () => {
    // Pre-seed install state to skip the prompt
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

  it('spawns doctor and polls when permissions are missing', async () => {
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

    expect(deps.spawnDoctor).toHaveBeenCalledOnce();
    expect(probeCount).toBeGreaterThanOrEqual(3);
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

    expect(deps.spawnDoctor).not.toHaveBeenCalled();
  });

  it('re-spawns doctor when permission kind changes mid-poll', async () => {
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

    // spawnDoctor must be called exactly twice:
    //   1. initial spawn for 'accessibility'
    //   2. re-spawn on transition to 'screenRecording'
    expect(deps.spawnDoctor).toHaveBeenCalledTimes(2);
    // A re-open message must have been emitted naming 'screenRecording'
    expect(messages.some((m) => m.includes('screenRecording'))).toBe(true);
  });

  it('skips permission probe when client is already started (no Finder spam on every tool call)', async () => {
    // Regression: probePermissions used to fire on every runBootstrap call,
    // which meant every computer_use__* tool invocation re-probed Finder
    // via get_app_state — repeatedly bringing Finder to the foreground.
    // The fix only probes on a fresh client start.
    const { saveInstallState } = await import('./install-state.js');
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });

    // Pre-started client: simulate a second tool call within the same session.
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

    // start() must not be called again (client was already started)
    expect(startSpy).not.toHaveBeenCalled();
    // probePermissions must NOT be called — this is the regression guard
    expect(deps.probePermissions).not.toHaveBeenCalled();
    // spawnDoctor likewise stays quiet
    expect(deps.spawnDoctor).not.toHaveBeenCalled();
  });
});

describe('probeFinderPermissions', () => {
  it("returns 'accessibility' when result has isError=true with AX permission text", async () => {
    const fakeClient = {
      callTool: vi.fn(async () => ({
        isError: true,
        content: [
          { type: 'text', text: 'Accessibility permission is required.' },
        ],
      })),
    };
    const result = await probeFinderPermissions(fakeClient as never);
    expect(result).toBe('accessibility');
  });

  it("returns 'screenRecording' when result is success but has no image content", async () => {
    const fakeClient = {
      callTool: vi.fn(async () => ({
        isError: false,
        content: [
          { type: 'text', text: '<AXApplication>Finder</AXApplication>' },
        ],
      })),
    };
    const result = await probeFinderPermissions(fakeClient as never);
    expect(result).toBe('screenRecording');
  });

  it("returns 'ok' when result has both text and image content", async () => {
    const fakeClient = {
      callTool: vi.fn(async () => ({
        isError: false,
        content: [
          { type: 'text', text: '<AXApplication>Finder</AXApplication>' },
          { type: 'image', data: 'base64data==', mimeType: 'image/png' },
        ],
      })),
    };
    const result = await probeFinderPermissions(fakeClient as never);
    expect(result).toBe('ok');
  });
});
