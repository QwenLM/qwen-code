/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from './errors.js';
import { isBunRuntime } from './runtime-info.js';

export type PtyImplementation = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  module: any;
  name: 'lydell-node-pty' | 'node-pty' | 'qwen-bun-pty';
} | null;

export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

export interface PtyLoadResult {
  /** The loaded backend, or null when this call found none. */
  impl: PtyImplementation;
  /**
   * Why THIS call found no backend, or null when one loaded. A backend that is
   * installed but cannot be loaded — a prebuild whose native module fails to
   * dlopen, e.g. an OS signature refusal or a host glibc older than the one it
   * was built against — collapses to `impl: null` exactly like an absent one,
   * so the reason travels on the result itself (#11872). It deliberately is
   * not module state: every call would have to share it, and a concurrent
   * caller could then overwrite the reason before this caller reads it.
   * loadPty() never rejects.
   */
  loadError: string | null;
}

/**
 * Resolve a PTY backend, reporting on the returned value why this call found
 * none. Callers that must tell the user *why* PTY support is missing use this;
 * callers that only need the backend use getPty().
 */
export const loadPty = async (): Promise<PtyLoadResult> => {
  // @lydell/node-pty's wrapper feeds the master fd through a `tty.ReadStream`,
  // which Bun destroys on the first EAGAIN — the child then runs on with no
  // output ever arriving. Under Bun, drive the same pinned native addon
  // through the thin backend in bun-pty.ts instead; the Node path is untouched.
  if (isBunRuntime()) {
    if (process.platform === 'win32') {
      return {
        impl: null,
        loadError:
          'the PTY backend is not yet available under the Bun runtime on Windows; use the Node runtime',
      };
    }
    try {
      const module = await import('./bun-pty.js');
      // The import alone proves nothing: the addon is loaded by path from
      // the platform package, so probe it here and let a missing prebuild
      // degrade to null like the Node arm's import-time failure.
      module.loadAddon();
      return { impl: { module, name: 'qwen-bun-pty' }, loadError: null };
    } catch (error) {
      return { impl: null, loadError: getErrorMessage(error) };
    }
  }

  try {
    const lydell = '@lydell/node-pty';
    const module = await import(lydell);
    return { impl: { module, name: 'lydell-node-pty' }, loadError: null };
  } catch (lydellError) {
    try {
      const nodePty = 'node-pty';
      const module = await import(nodePty);
      return { impl: { module, name: 'node-pty' }, loadError: null };
    } catch (nodePtyError) {
      return {
        impl: null,
        loadError: [lydellError, nodePtyError]
          .map((error) => getErrorMessage(error))
          .join('; '),
      };
    }
  }
};

// getPty() must keep RESOLVING null and keep the `PtyImplementation` return
// type: ShellExecutionService turns a rejection into a thrown error, which
// would replace today's graceful childProcessFallback. Callers that need the
// reason load via loadPty() instead.
export const getPty = async (): Promise<PtyImplementation> =>
  (await loadPty()).impl;
