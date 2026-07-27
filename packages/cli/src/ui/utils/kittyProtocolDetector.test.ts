/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The detector relies on real `process.stdin`/`process.stdout` globals and
// carries one-shot module-level state (detection runs once per process), so
// each case imports a fresh copy of the module against mocked TTY streams.

interface MockStdin extends EventEmitter {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (raw: boolean) => void;
}

function installMockStreams(): { stdin: MockStdin; writes: string[] } {
  const stdin = new EventEmitter() as MockStdin;
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (raw: boolean) => {
    stdin.isRaw = raw;
  };
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  Object.defineProperty(process, 'stdin', {
    value: stdin,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });
  return { stdin, writes };
}

const KITTY_PUSH = '\x1b[>1u';
const KITTY_POP = '\x1b[<u';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

describe('kittyProtocolDetector', () => {
  const realStdin = process.stdin;
  const realStdoutIsTTY = process.stdout.isTTY;
  let exitListenersBefore: Set<unknown>;

  beforeEach(() => {
    vi.resetModules();
    exitListenersBefore = new Set(process.listeners('exit'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'stdin', {
      value: realStdin,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: realStdoutIsTTY,
      configurable: true,
    });
    // Remove exit listeners added during the test (the detection module
    // registers one) without affecting framework listeners.
    const current = process.listeners('exit');
    for (const listener of current) {
      if (!exitListenersBefore.has(listener)) {
        process.removeListener('exit', listener);
      }
    }
  });

  async function detectWithSupport(stdin: MockStdin) {
    const mod = await import('./kittyProtocolDetector.js');
    const promise = mod.detectAndEnableKittyProtocol();
    // Progressive-enhancement reply (CSI ? <flags> u) then device attributes
    // (CSI ? <attrs> c) — the pair the detector waits for to enable.
    stdin.emit('data', Buffer.from('\x1b[?1u'));
    stdin.emit('data', Buffer.from('\x1b[?62;c'));
    await promise;
    return mod;
  }

  it('pushes the enable sequence when the terminal supports the protocol', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);

    expect(mod.isKittyProtocolSupported()).toBe(true);
    expect(mod.isKittyProtocolEnabled()).toBe(true);
    expect(writes).toContain(KITTY_PUSH);
  });

  it('re-pushes the flags on demand (alternate-screen re-entry)', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);

    writes.length = 0;
    mod.pushKittyProtocolFlags();

    expect(writes).toEqual([KITTY_PUSH]);
  });

  it('tracks the push depth across main and alternate screens', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);

    expect(mod.getKittyProtocolDepth()).toBe(1);

    mod.pushKittyProtocolFlags();
    expect(mod.getKittyProtocolDepth()).toBe(2);

    writes.length = 0;
    mod.popKittyProtocolFlags();
    expect(mod.getKittyProtocolDepth()).toBe(1);
    expect(writes).toEqual([KITTY_POP]);

    mod.popKittyProtocolFlags();
    expect(mod.getKittyProtocolDepth()).toBe(0);
    expect(mod.isKittyProtocolEnabled()).toBe(false);
    expect(writes).toEqual([KITTY_POP, KITTY_POP]);
  });

  it('does not write a pop when the depth is already zero', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);

    mod.popKittyProtocolFlags();
    writes.length = 0;
    mod.popKittyProtocolFlags();

    expect(writes).toEqual([]);
    expect(mod.getKittyProtocolDepth()).toBe(0);
  });

  it('balances both screen-buffer stacks in the exit fallback', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);
    mod.pushKittyProtocolFlags();
    expect(mod.getKittyProtocolDepth()).toBe(2);

    const newExitListener = process
      .listeners('exit')
      .find((listener) => !exitListenersBefore.has(listener));
    expect(newExitListener).toBeDefined();

    writes.length = 0;
    newExitListener?.(0);

    expect(writes.join('')).toBe(`${KITTY_POP}${EXIT_ALT_SCREEN}${KITTY_POP}`);
    expect(mod.getKittyProtocolDepth()).toBe(0);
  });

  it('does not install raw SIGINT or SIGTERM Kitty pop handlers', async () => {
    const { stdin } = installMockStreams();
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    await detectWithSupport(stdin);

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('is a no-op when the protocol is unsupported', async () => {
    const { writes } = installMockStreams();
    const mod = await import('./kittyProtocolDetector.js');
    // No detection ran → unsupported. Re-push must not write anything.
    writes.length = 0;
    mod.pushKittyProtocolFlags();

    expect(writes).toEqual([]);
    expect(mod.isKittyProtocolSupported()).toBe(false);
  });
});
