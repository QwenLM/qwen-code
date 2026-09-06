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
// Stand-ins for Ink's alternate-screen management, used to assert the pop
// ordering around the buffer switch (#7779).
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

describe('kittyProtocolDetector', () => {
  const realStdin = process.stdin;
  const realStdoutIsTTY = process.stdout.isTTY;
  let baselineExitListeners: NodeJS.ExitListener[];

  beforeEach(() => {
    vi.resetModules();
    baselineExitListeners = process.listeners('exit') as NodeJS.ExitListener[];
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
    // Each fresh module copy that detects support registers its own
    // process-'exit' fallback; drop the ones added during the case so they
    // cannot fire into a later case's mocked stdout.
    for (const listener of process.listeners('exit') as NodeJS.ExitListener[]) {
      if (!baselineExitListeners.includes(listener)) {
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

  it('is a no-op when the protocol is unsupported', async () => {
    const { writes } = installMockStreams();
    const mod = await import('./kittyProtocolDetector.js');
    // No detection ran → unsupported. Re-push, pops and the fallback
    // re-arm must not write anything.
    writes.length = 0;
    mod.pushKittyProtocolFlags();
    mod.popKittyProtocolFlags();
    mod.disableKittyProtocol();
    mod.deferKittyProtocolExitFallback();

    expect(writes).toEqual([]);
    expect(mod.isKittyProtocolSupported()).toBe(false);
    expect(mod.isKittyProtocolEnabled()).toBe(false);
  });

  // Regression for #7779: with the alternate screen in play the flags are
  // pushed once per screen buffer, and each push must be popped while its
  // buffer is still current — the alternate-screen pop strictly before the
  // renderer leaves the alternate screen (`ESC[?1049l`), the main-screen pop
  // strictly after returning to the main screen. The detection-time push on
  // the main screen happened before this snapshot, so the assertion covers
  // the writes from the alternate-screen switch through final teardown.
  it('balances every push on its own screen buffer across the VP lifecycle', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);
    writes.length = 0;

    // Ink's render() enters the alternate screen, then the app re-pushes the
    // flags onto it (startInteractiveUI's useVP path).
    process.stdout.write(ENTER_ALT_SCREEN);
    mod.pushKittyProtocolFlags();

    // Teardown: pop the alternate screen's flags BEFORE leaving it, then
    // leave, then pop the main screen's flags after returning.
    mod.popKittyProtocolFlags();
    process.stdout.write(LEAVE_ALT_SCREEN);
    mod.disableKittyProtocol();

    expect(writes).toEqual([
      ENTER_ALT_SCREEN,
      KITTY_PUSH,
      KITTY_POP,
      LEAVE_ALT_SCREEN,
      KITTY_POP,
    ]);
    expect(mod.isKittyProtocolEnabled()).toBe(false);

    // Fully balanced: further pops are no-ops (no double-pop that could
    // evict a flag entry the user's shell pushed).
    writes.length = 0;
    mod.popKittyProtocolFlags();
    mod.disableKittyProtocol();
    expect(writes).toEqual([]);
  });

  it('tracks the two screen buffers independently', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);

    // A second alternate-screen push while one is already active must not
    // push again (the stack would need a matching extra pop).
    writes.length = 0;
    mod.pushKittyProtocolFlags();
    mod.pushKittyProtocolFlags();
    expect(writes).toEqual([KITTY_PUSH]);

    // Popping the alternate screen twice must not write a second pop either.
    writes.length = 0;
    mod.popKittyProtocolFlags();
    mod.popKittyProtocolFlags();
    expect(writes).toEqual([KITTY_POP]);

    // The main screen's push is still active and still reported as enabled.
    expect(mod.isKittyProtocolEnabled()).toBe(true);

    // disableKittyProtocol on the main screen writes exactly one pop — not
    // a second one for the (already popped) alternate screen.
    writes.length = 0;
    mod.disableKittyProtocol();
    expect(writes).toEqual([KITTY_POP]);
    expect(mod.isKittyProtocolEnabled()).toBe(false);
  });

  it('leaks no pop for the alternate screen when disabling on the main screen', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);
    mod.pushKittyProtocolFlags();

    // Crash-path shape: teardown runs on the main screen without the
    // pre-leave pop. Writing a pop "for" the alternate screen here would hit
    // the main screen's stack and could evict an entry the shell pushed, so
    // exactly one pop (the main screen's own push) must be written.
    writes.length = 0;
    mod.disableKittyProtocol();
    expect(writes).toEqual([KITTY_POP]);
    expect(mod.isKittyProtocolEnabled()).toBe(false);
  });

  it('pops the main-screen push from the process-exit fallback exactly once', async () => {
    const { stdin, writes } = installMockStreams();
    await detectWithSupport(stdin);

    const fallbacks = (
      process.listeners('exit') as NodeJS.ExitListener[]
    ).filter((listener) => !baselineExitListeners.includes(listener));
    expect(fallbacks).toHaveLength(1);

    writes.length = 0;
    fallbacks[0]!(0);
    expect(writes).toEqual([KITTY_POP]);

    // The fallback is idempotent: a second 'exit' pass must not pop again.
    writes.length = 0;
    fallbacks[0]!(0);
    expect(writes).toEqual([]);
  });

  it('re-arms the exit fallback behind listeners registered after detection', async () => {
    const { stdin, writes } = installMockStreams();
    const mod = await detectWithSupport(stdin);

    // Stand-in for Ink's render-time signal-exit subscription, registered
    // after detection and before the re-arm (mirrors startInteractiveUI).
    const inkExitTeardown = () => {};
    process.on('exit', inkExitTeardown);
    try {
      mod.deferKittyProtocolExitFallback();

      const listeners = process.listeners('exit') as NodeJS.ExitListener[];
      // The fallback must now sit behind the render-time teardown so its pop
      // lands after Ink restored the terminal and left the alternate screen.
      expect(listeners[listeners.length - 1]).not.toBe(inkExitTeardown);
      expect(listeners.indexOf(inkExitTeardown)).toBeLessThan(
        listeners.length - 1,
      );

      // The re-armed listener is still the detector's fallback: invoking it
      // pops the main-screen push once.
      writes.length = 0;
      (listeners[listeners.length - 1] as (code: number) => void)(0);
      expect(writes).toEqual([KITTY_POP]);
    } finally {
      process.removeListener('exit', inkExitTeardown);
    }
  });
});
