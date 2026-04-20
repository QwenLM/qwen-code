/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installSynchronizedOutput } from './synchronizedOutput.js';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

describe('installSynchronizedOutput', () => {
  let originalIsTTY: boolean | undefined;
  let originalWrite: typeof process.stdout.write;
  let originalEnv: NodeJS.ProcessEnv;
  let uninstall: () => void;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    originalWrite = process.stdout.write;
    originalEnv = { ...process.env };
    uninstall = () => {};
  });

  afterEach(() => {
    try {
      uninstall();
    } catch {
      // best-effort cleanup
    }
    // Restore stdout write in case a test failed before uninstalling
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
    process.env = originalEnv;
  });

  it('is a no-op when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });
    process.env['TERM_PROGRAM'] = 'iTerm.app';

    uninstall = installSynchronizedOutput();
    expect(process.stdout.write).toBe(originalWrite);
  });

  it('is a no-op on unsupported terminals', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    // Simulate a terminal we do not recognize.
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    delete process.env['TERM'];
    delete process.env['KITTY_WINDOW_ID'];
    delete process.env['WT_SESSION'];
    delete process.env['ZED_TERM'];
    delete process.env['VTE_VERSION'];

    uninstall = installSynchronizedOutput();
    expect(process.stdout.write).toBe(originalWrite);
  });

  it('is a no-op inside tmux even on otherwise-supported terminals', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    process.env['TMUX'] = '/tmp/tmux-1000/default,1234,0';

    uninstall = installSynchronizedOutput();
    expect(process.stdout.write).toBe(originalWrite);
  });

  it('wraps writes on supported terminals with BSU/ESU', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    delete process.env['TMUX'];

    // Capture what the patched write forwards to the underlying stream.
    const writes: string[] = [];
    const fakeWrite = vi.fn<Parameters<typeof process.stdout.write>, boolean>(
      (chunk: unknown) => {
        writes.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = fakeWrite;

    uninstall = installSynchronizedOutput();

    // First write of a burst: should emit BSU before the payload.
    process.stdout.write('frame-1-part-a');
    process.stdout.write('frame-1-part-b');

    // ESU lands via queueMicrotask; let microtasks drain.
    await Promise.resolve();

    expect(writes).toEqual([BSU, 'frame-1-part-a', 'frame-1-part-b', ESU]);

    // Next burst after the microtask: a fresh BSU/ESU pair.
    writes.length = 0;
    process.stdout.write('frame-2');
    await Promise.resolve();
    expect(writes).toEqual([BSU, 'frame-2', ESU]);
  });

  it('returns a cleanup that stops wrapping writes in BSU/ESU', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    delete process.env['TMUX'];

    const writes: string[] = [];
    const fakeWrite = vi.fn<Parameters<typeof process.stdout.write>, boolean>(
      (chunk: unknown) => {
        writes.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = fakeWrite;

    uninstall = installSynchronizedOutput();
    expect(process.stdout.write).not.toBe(fakeWrite);

    // Sanity: while installed, writes get BSU/ESU.
    process.stdout.write('installed');
    await Promise.resolve();
    expect(writes).toEqual([BSU, 'installed', ESU]);

    uninstall();
    writes.length = 0;

    // After uninstall, writes pass through without any BSU/ESU.
    process.stdout.write('uninstalled');
    await Promise.resolve();
    expect(writes).toEqual(['uninstalled']);
  });
});
