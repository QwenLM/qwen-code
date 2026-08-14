/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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

/**
 * Environment variable that re-enables PTY spawning under Bun.
 *
 * Bun is able to load `@lydell/node-pty`, but doing so hangs under the
 * Desktop runtime, so PTY is disabled by default whenever we detect Bun.
 * The standalone CLI does not hit that Desktop hang, so operators can set
 * `QWEN_TUI_FORCE_PTY=1` to opt back in and restore interactive-shell (PTY)
 * support. The default remains disabled to protect the Desktop case.
 */
export const BUN_FORCE_PTY_ENV_VAR = 'QWEN_TUI_FORCE_PTY';

export const getPty = async (): Promise<PtyImplementation> => {
  // Bun can load @lydell/node-pty, but it hangs under Desktop's runtime, so
  // PTY stays off by default on Bun. Set QWEN_TUI_FORCE_PTY=1 to re-enable it
  // in runtimes (e.g. the standalone CLI) that do not hit that hang.
  if ('bun' in process.versions && process.env[BUN_FORCE_PTY_ENV_VAR] !== '1') {
    return null;
  }

  try {
    const lydell = '@lydell/node-pty';
    const module = await import(lydell);
    return { module, name: 'lydell-node-pty' };
  } catch (_e) {
    try {
      const nodePty = 'node-pty';
      const module = await import(nodePty);
      return { module, name: 'node-pty' };
    } catch (_e2) {
      return null;
    }
  }
};
