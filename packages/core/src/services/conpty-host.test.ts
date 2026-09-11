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
    const coreManifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { optionalDependencies: Record<string, string> };
    const rootManifest = JSON.parse(
      readFileSync(
        new URL('../../../../package.json', import.meta.url),
        'utf8',
      ),
    ) as { optionalDependencies: Record<string, string> };

    const corePins = Object.fromEntries(
      Object.entries(coreManifest.optionalDependencies).filter(([name]) =>
        name.startsWith('@lydell/node-pty'),
      ),
    );
    const rootPins = Object.fromEntries(
      Object.entries(rootManifest.optionalDependencies).filter(([name]) =>
        name.startsWith('@lydell/node-pty'),
      ),
    );

    // Every platform pin core declares must be the verified version, so a bump
    // of any one — not just the loader key — turns this red and forces the
    // human re-check the comment above describes. The WindowsPtyAgent field
    // shape and conpty.cc baton-erase semantics live in the win32 prebuilds, so
    // those keys must trip the same guard as the loader.
    expect(Object.keys(corePins)).toHaveLength(6);
    expect(
      Object.values(corePins).every((version) => version === VERIFIED_NODE_PTY),
    ).toBe(true);
    // packages/cli declares no node-pty and resolves the root-hoisted copy, so
    // the root manifest's six must stay in lockstep with core's six — the
    // declaration agent-view actually loads in a dev tree.
    expect(corePins).toEqual(rootPins);
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
