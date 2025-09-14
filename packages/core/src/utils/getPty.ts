/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents a dynamically imported pseudo-terminal (PTY) implementation.
 */
export type PtyImplementation = {
  /**
   * The imported module, which can be either `@lydell/node-pty` or `node-pty`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  module: any;
  /**
   * The name of the PTY implementation.
   */
  name: 'lydell-node-pty' | 'node-pty';
} | null;

/**
 * An interface that abstracts the core functionality of a PTY process.
 */
export interface PtyProcess {
  /**
   * The process ID of the PTY.
   */
  readonly pid: number;
  /**
   * Registers a callback to handle data output from the PTY.
   * @param callback The function to call with the data.
   */
  onData(callback: (data: string) => void): void;
  /**
   * Registers a callback to handle the exit event of the PTY.
   * @param callback The function to call with the exit information.
   */
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
  /**
   * Kills the PTY process.
   * @param signal The signal to send to the process (e.g., 'SIGKILL').
   */
  kill(signal?: string): void;
}

/**
 * Dynamically imports a pseudo-terminal (PTY) implementation.
 * It first tries to import `@lydell/node-pty`, and if that fails, it falls back to `node-pty`.
 * This is necessary because `node-pty` has pre-built binaries that may not be available on all systems,
 * while `@lydell/node-pty` is a fork that often works in those cases.
 * @returns A promise that resolves to a `PtyImplementation` object, or `null` if neither implementation can be imported.
 */
export const getPty = async (): Promise<PtyImplementation> => {
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
