/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the headless kitty-keyboard negotiation probe: terminals that
 * answer `\x1b[?u` get kitty mode; terminals that only answer the device
 * attributes query, never answer, or are not TTYs fall back to legacy input
 * (probe resolves false → `useKittyKeyboard: null`).
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { probeKittyKeyboardSupport } from './kitty-negotiation.js';

interface FakeStdin extends EventEmitter {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(raw: boolean): void;
}

function makeStdin(isTTY = true): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = isTTY;
  stdin.isRaw = false;
  stdin.setRawMode = (raw: boolean) => {
    stdin.isRaw = raw;
  };
  return stdin;
}

function makeStdout(isTTY = true): {
  isTTY: boolean;
  writes: string[];
  write(chunk: string): boolean;
} {
  const writes: string[] = [];
  return {
    isTTY,
    writes,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

describe('probeKittyKeyboardSupport', () => {
  it('resolves true when the terminal answers the kitty query', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const probe = probeKittyKeyboardSupport({
      stdin,
      stdout,
      timeoutMs: 500,
    });
    stdin.emit('data', Buffer.from('\x1b[?1u'));
    await expect(probe).resolves.toBe(true);
    expect(stdout.writes).toContain('\x1b[?u');
  });

  it('resolves false when only a device-attributes reply arrives', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const probe = probeKittyKeyboardSupport({
      stdin,
      stdout,
      timeoutMs: 500,
    });
    stdin.emit('data', Buffer.from('\x1b[?62;22c'));
    await expect(probe).resolves.toBe(false);
  });

  it('resolves false on timeout when the terminal never answers', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    await expect(
      probeKittyKeyboardSupport({
        stdin,
        stdout,
        timeoutMs: 20,
      }),
    ).resolves.toBe(false);
    expect(stdout.writes).toContain('\x1b[?u');
    expect(stdout.writes).toContain('\x1b[c');
  });

  it('resolves false without querying when stdin is not a TTY', async () => {
    const stdin = makeStdin(false);
    const stdout = makeStdout();
    await expect(probeKittyKeyboardSupport({ stdin, stdout })).resolves.toBe(
      false,
    );
    expect(stdout.writes).toEqual([]);
  });

  it('resolves false without querying when stdout is not a TTY', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout(false);
    await expect(probeKittyKeyboardSupport({ stdin, stdout })).resolves.toBe(
      false,
    );
    expect(stdout.writes).toEqual([]);
  });

  it('restores raw mode after the probe', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const probe = probeKittyKeyboardSupport({
      stdin,
      stdout,
      timeoutMs: 500,
    });
    expect(stdin.isRaw).toBe(true); // enabled while probing
    stdin.emit('data', Buffer.from('\x1b[?1u'));
    await probe;
    expect(stdin.isRaw).toBe(false);
  });

  it('keeps the probe detection-only (never pushes kitty flags)', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const probe = probeKittyKeyboardSupport({
      stdin,
      stdout,
      timeoutMs: 500,
    });
    stdin.emit('data', Buffer.from('\x1b[?1u'));
    await probe;
    expect(stdout.writes).not.toContain('\x1b[>1u');
    expect(stdout.writes).not.toContain('\x1b[<u');
  });

  it('does not resolve on an echo of the probe query itself (no flags)', async () => {
    // Echo environments (PTY harnesses, canonical-mode CI) replay stdout
    // into stdin; the bare query \x1b[?u has no flags parameter and must
    // not count as a kitty reply.
    const stdin = makeStdin();
    const stdout = makeStdout();
    const probe = probeKittyKeyboardSupport({
      stdin,
      stdout,
      timeoutMs: 20,
    });
    stdin.emit('data', Buffer.from('\x1b[?u'));
    await expect(probe).resolves.toBe(false);
  });

  it('bounds the accumulation window under byte floods', async () => {
    // A PTY streaming non-matching bytes must not grow the buffer or slow
    // the probe; the timeout still settles the probe.
    const stdin = makeStdin();
    const stdout = makeStdout();
    const probe = probeKittyKeyboardSupport({
      stdin,
      stdout,
      timeoutMs: 20,
    });
    for (let i = 0; i < 100; i++) {
      stdin.emit('data', Buffer.from('x'.repeat(1024)));
    }
    await expect(probe).resolves.toBe(false);
  });

  it('still resolves true when the reply is split across chunks', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const probe = probeKittyKeyboardSupport({
      stdin,
      stdout,
      timeoutMs: 500,
    });
    stdin.emit('data', Buffer.from('\x1b'));
    stdin.emit('data', Buffer.from('[?1'));
    stdin.emit('data', Buffer.from('u'));
    await expect(probe).resolves.toBe(true);
  });
});
