/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from './errors.js';

export type PtyImplementation = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  module: any;
  name: 'lydell-node-pty' | 'node-pty';
} | null;

export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

// Why the last getPty() call produced no backend. A backend that is installed
// but cannot be loaded — a prebuild whose native module fails to dlopen, e.g.
// an OS signature refusal or a host glibc older than the one it was built
// against — collapses to null exactly like an absent one, so the reason is
// kept here for callers that report it to the user (#11872). getPty() itself
// must keep RESOLVING null: ShellExecutionService turns a rejection into a
// thrown error, which would replace today's graceful childProcessFallback.
let ptyLoadError: string | null = null;

export const getPtyLoadError = (): string | null => ptyLoadError;

export const getPty = async (): Promise<PtyImplementation> => {
  ptyLoadError = null;
  // Bun can load @lydell/node-pty, but it hangs under Desktop's runtime.
  if ('bun' in process.versions) {
    ptyLoadError = 'the Bun runtime has no PTY backend';
    return null;
  }

  try {
    const lydell = '@lydell/node-pty';
    const module = await import(lydell);
    return { module, name: 'lydell-node-pty' };
  } catch (lydellError) {
    try {
      const nodePty = 'node-pty';
      const module = await import(nodePty);
      return { module, name: 'node-pty' };
    } catch (nodePtyError) {
      ptyLoadError = [lydellError, nodePtyError]
        .map((error) => getErrorMessage(error))
        .join('; ');
      return null;
    }
  }
};
