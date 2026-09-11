/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { osPlatform } = vi.hoisted(() => ({ osPlatform: vi.fn() }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const patched = { ...actual, platform: osPlatform };
  return { ...patched, default: patched };
});

import {
  disposeConoutWorker,
  noteConPtyHostReleased,
  releaseConPtyHost,
} from './conpty-host.js';

// The exact @lydell/node-pty pin whose JS field shape and native teardown
// semantics the release path in conpty-host.ts was verified against. A
// version bump turns this test red on purpose: re-check the WindowsPtyAgent
// fields and src/win/conpty.cc (the baton erase became unconditional in
// 1.2.0-beta.14 — see conpty-host.ts) before updating the constant.
const VERIFIED_NODE_PTY = '1.2.0-beta.10';

describe('conpty-host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    osPlatform.mockReturnValue('win32');
  });

  it('pins the verified @lydell/node-pty version', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { optionalDependencies: Record<string, string> };

    expect(packageJson.optionalDependencies['@lydell/node-pty']).toBe(
      VERIFIED_NODE_PTY,
    );
  });

  it('drives the release through the WindowsPtyAgent internals shape', () => {
    // The field shape releaseConPtyHost consumes: a node-pty bump that
    // renames these fields silently degrades the release to a warn + no-op.
    const nativeKill = vi.fn();
    const conoutDispose = vi.fn();
    const pty = {
      _agent: {
        _pty: 42,
        _useConptyDll: false,
        _ptyNative: { kill: nativeKill },
        _conoutSocketWorker: { dispose: conoutDispose },
      },
    };

    releaseConPtyHost(pty);

    expect(nativeKill).toHaveBeenCalledWith(42, false);
    expect(conoutDispose).toHaveBeenCalledOnce();
  });

  it('disposes only the worker when a bundled PTY was already killed', () => {
    // A kill() that really ran records the note; on the bundled backend the
    // release must then skip the native close but still dispose the worker
    // node-pty defers until more output.
    const nativeKill = vi.fn();
    const conoutDispose = vi.fn();
    const pty = {
      _agent: {
        _pty: 42,
        _useConptyDll: true,
        _ptyNative: { kill: nativeKill },
        _conoutSocketWorker: { dispose: conoutDispose },
      },
    };
    noteConPtyHostReleased(pty);

    releaseConPtyHost(pty);

    expect(nativeKill).not.toHaveBeenCalled();
    expect(conoutDispose).toHaveBeenCalledOnce();
  });

  it('leaves a noted inbox PTY completely alone', () => {
    // The `_useConptyDll` discriminator: with the inbox backend a noted PTY
    // needs neither a second native close nor the worker dispose.
    const nativeKill = vi.fn();
    const conoutDispose = vi.fn();
    const pty = {
      _agent: {
        _pty: 42,
        _useConptyDll: false,
        _ptyNative: { kill: nativeKill },
        _conoutSocketWorker: { dispose: conoutDispose },
      },
    };
    noteConPtyHostReleased(pty);

    releaseConPtyHost(pty);

    expect(nativeKill).not.toHaveBeenCalled();
    expect(conoutDispose).not.toHaveBeenCalled();
  });

  it('never touches the PTY off Windows', () => {
    osPlatform.mockReturnValue('linux');
    const nativeKill = vi.fn();
    const conoutDispose = vi.fn();
    const pty = {
      _agent: {
        _pty: 42,
        _useConptyDll: true,
        _ptyNative: { kill: nativeKill },
        _conoutSocketWorker: { dispose: conoutDispose },
      },
    };

    releaseConPtyHost(pty);
    disposeConoutWorker(pty);

    expect(nativeKill).not.toHaveBeenCalled();
    expect(conoutDispose).not.toHaveBeenCalled();
  });
});
