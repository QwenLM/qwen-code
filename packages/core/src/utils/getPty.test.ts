/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { getPty, loadPty } from './getPty.js';

// `@lydell/node-pty` is vendored in this repo's node_modules, so a plain
// import resolves on the build host and the "neither backend loaded" arm would
// never run. Fail it the way a broken prebuild does, and let the genuinely
// absent `node-pty` specifier fail on its own, so both messages in the reason
// are produced by the code under test rather than supplied by the test.
vi.mock('@lydell/node-pty', () => {
  throw new Error('native module failed to dlopen: pty.node');
});

// getPty.ts branches on `'bun' in process.versions`; this mirrors the marker
// Desktop's Bun build carries without touching the real descriptor.
function markBunRuntime(): () => void {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'bun');

  Object.defineProperty(process.versions, 'bun', {
    value: '1.3.8',
    configurable: true,
  });

  return () => {
    if (original) {
      Object.defineProperty(process.versions, 'bun', original);
    } else {
      const versions = process.versions as typeof process.versions & {
        bun?: string;
      };
      delete versions.bun;
    }
  };
}

// The Bun PTY backend is POSIX-only (bun-pty.ts); Windows stays gated under
// Bun until ConPTY is validated there. The real-load test is host-gated;
// interleaving tests pin POSIX and mock only the native load probe so they
// exercise call isolation without requiring another host's native package.
// Neither a spoofed platform nor a skipped real-load test validates Windows.
function markPosix(): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');

  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  });

  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  };
}

function markWin32(): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');

  Object.defineProperty(process, 'platform', {
    value: 'win32',
    configurable: true,
  });

  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  };
}

describe('getPty', () => {
  it.runIf(process.platform !== 'win32')(
    'loads the real PTY backend under Bun',
    async () => {
      const restoreBun = markBunRuntime();

      try {
        // Loading probes the addon but must not spawn anything — the
        // child is only created inside spawn().
        const { impl, loadError } = await loadPty();

        expect(loadError).toBeNull();
        expect(impl).not.toBeNull();
        expect(impl?.name).toBe('qwen-bun-pty');
        await expect(getPty()).resolves.toMatchObject({
          name: 'qwen-bun-pty',
        });
      } finally {
        restoreBun();
      }
    },
  );

  it('keeps the honest gate on Windows under Bun', async () => {
    const restoreBun = markBunRuntime();
    const restorePlatform = markWin32();

    try {
      const { impl, loadError } = await loadPty();

      expect(impl).toBeNull();
      expect(loadError).toMatch(/Bun runtime/);
      expect(loadError).toMatch(/Windows/);
      await expect(getPty()).resolves.toBeNull();
    } finally {
      restorePlatform();
      restoreBun();
    }
  });

  it('reports a Bun prebuild that fails to load as no backend', async () => {
    const restoreBun = markBunRuntime();
    const restorePlatform = markPosix();
    vi.resetModules();
    vi.doMock('./bun-pty.js', () => ({
      loadAddon: () => {
        throw new Error("Cannot find module '@lydell/node-pty-linux-x64'");
      },
    }));

    try {
      const fresh = await import('./getPty.js');
      const { impl, loadError } = await fresh.loadPty();

      expect(impl).toBeNull();
      expect(loadError).toMatch(/Cannot find module/);
      await expect(fresh.getPty()).resolves.toBeNull();
    } finally {
      vi.doUnmock('./bun-pty.js');
      vi.resetModules();
      restorePlatform();
      restoreBun();
    }
  });

  it('joins both backend failures into the reason of the call that saw them', async () => {
    const { impl, loadError } = await loadPty();

    expect(impl).toBeNull();
    // Both imports failed, both messages reported, in the order they were
    // tried, joined into one sentence — not collapsed to the first failure.
    // (vitest wraps the mocked import's rejection, so match the inner message
    // this module produced.)
    const failures = [loadError].flatMap((reason) =>
      (reason ?? '').split('; '),
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/native module failed to dlopen: pty\.node/);
    expect(failures[1]).toMatch(/node-pty/);
    // ...and not another arm's reason.
    expect(loadError).not.toMatch(/Bun runtime/);
  });

  it("keeps each call's own result when another call lands in between", async () => {
    vi.resetModules();
    const addonProbe = vi.fn();
    vi.doMock('./bun-pty.js', () => ({ loadAddon: addonProbe }));
    try {
      const { loadPty: isolatedLoadPty } = await import('./getPty.js');
      // The failing Node call starts before the Bun call but is read after it.
      // Only native loading is simulated; per-call result ownership is real.
      const failing = isolatedLoadPty();
      await new Promise((resolve) => setImmediate(resolve));
      const restoreBun = markBunRuntime();
      const restorePlatform = markPosix();
      try {
        const bun = await isolatedLoadPty();
        expect(bun.impl?.name).toBe('qwen-bun-pty');
        expect(bun.loadError).toBeNull();
        expect(addonProbe).toHaveBeenCalledOnce();
      } finally {
        restorePlatform();
        restoreBun();
      }
      const failed = await failing;
      expect(failed.impl).toBeNull();
      expect(failed.loadError).toMatch(
        /native module failed to dlopen: pty\.node/,
      );
      expect(failed.loadError).not.toMatch(/Bun runtime/);
    } finally {
      vi.doUnmock('./bun-pty.js');
      vi.resetModules();
    }
  });

  it("does not reuse a previous call's result for a later failure", async () => {
    vi.resetModules();
    const addonProbe = vi.fn();
    vi.doMock('./bun-pty.js', () => ({ loadAddon: addonProbe }));
    try {
      const { loadPty: isolatedLoadPty } = await import('./getPty.js');
      const restoreBun = markBunRuntime();
      const restorePlatform = markPosix();
      try {
        const bun = await isolatedLoadPty();
        expect(bun.impl?.name).toBe('qwen-bun-pty');
        expect(bun.loadError).toBeNull();
        expect(addonProbe).toHaveBeenCalledOnce();
      } finally {
        restorePlatform();
        restoreBun();
      }
      const later = await isolatedLoadPty();
      expect(later.impl).toBeNull();
      expect(later.loadError).toMatch(
        /native module failed to dlopen: pty\.node/,
      );
      expect(later.loadError).not.toMatch(/Bun runtime/);
    } finally {
      vi.doUnmock('./bun-pty.js');
      vi.resetModules();
    }
  });
});
