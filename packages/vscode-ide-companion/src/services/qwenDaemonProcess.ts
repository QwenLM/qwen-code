/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

export interface QwenDaemonRuntime {
  baseUrl: string;
  token: string;
}

export interface QwenDaemonListenerHandle {
  dispose(): void;
}

const STARTUP_TIMEOUT_MS = 30_000;
const LISTENING_URL = /qwen serve listening on (http:\/\/[^\s]+)/;

export class QwenDaemonProcess {
  private child: ChildProcess | null = null;
  private runtime: QwenDaemonRuntime | null = null;
  private startup: Promise<QwenDaemonRuntime> | null = null;
  /** Workspace the live daemon was bound to via `serve --workspace`. */
  private boundWorkspaceCwd: string | null = null;
  /** Notified when the live daemon exits after a successful start. */
  private exitListeners = new Set<() => void>();
  /**
   * Notified when the live daemon is replaced by a workspace switch, so
   * hosts still bound to the old runtime can surface the failure instead of
   * hanging against a dead port.
   */
  private supersededListeners = new Set<() => void>();

  addExitListener(listener: () => void): QwenDaemonListenerHandle {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  addSupersededListener(listener: () => void): QwenDaemonListenerHandle {
    this.supersededListeners.add(listener);
    return { dispose: () => this.supersededListeners.delete(listener) };
  }

  start(
    cliEntryPath: string,
    workspaceCwd: string,
  ): Promise<QwenDaemonRuntime> {
    // A daemon is bound to one workspace at spawn. Reusing it for a different
    // root — which a multi-root window hits as soon as a second chat opens
    // against another folder — would silently scope every session, history
    // page, and prompt to the first root instead.
    if (
      this.boundWorkspaceCwd !== null &&
      this.boundWorkspaceCwd !== workspaceCwd
    ) {
      this.dispose();
      for (const listener of [...this.supersededListeners]) listener();
    }
    if (
      this.runtime &&
      this.child &&
      this.child.exitCode === null &&
      this.boundWorkspaceCwd === workspaceCwd
    ) {
      return Promise.resolve(this.runtime);
    }
    if (this.startup) return this.startup;
    this.boundWorkspaceCwd = workspaceCwd;

    const token = randomBytes(32).toString('hex');
    this.startup = new Promise<QwenDaemonRuntime>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          cliEntryPath,
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          '0',
          '--workspace',
          workspaceCwd,
          '--no-web',
          '--require-auth',
          '--allow-origin',
          '*',
        ],
        {
          cwd: workspaceCwd,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE: '1',
            QWEN_SERVER_TOKEN: token,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      this.child = child;

      let settled = false;
      let output = '';
      const onStdout = (chunk: Buffer) => {
        output += chunk.toString();
        const match = LISTENING_URL.exec(output);
        if (match?.[1]) finish(undefined, match[1]);
      };
      const onStderr = (chunk: Buffer) => {
        output += chunk.toString();
      };
      const finish = (error?: Error, baseUrl?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        // The daemon lives for the whole IDE session and logs continuously;
        // once startup settles, the stdio handlers must stop retaining every
        // byte it writes.
        child.stdout?.removeListener('data', onStdout);
        child.stderr?.removeListener('data', onStderr);
        // `dispose()` clears the shared fields, so an attempt that was already
        // replaced (a workspace switch kills the old child while it is still
        // starting) must not run it — that would tear down its successor.
        if (this.child !== child) {
          child.kill();
          reject(
            error ?? new Error('Qwen daemon was superseded during startup'),
          );
          return;
        }
        this.startup = null;
        if (error || !baseUrl) {
          this.dispose();
          reject(error ?? new Error('Qwen daemon did not report its URL'));
          return;
        }
        this.runtime = { baseUrl, token };
        resolve(this.runtime);
      };

      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              `Timed out starting Qwen daemon${output ? `: ${output.slice(-500)}` : ''}`,
            ),
          ),
        STARTUP_TIMEOUT_MS,
      );

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        if (settled) {
          // Died after a successful start. Retract the runtime so the next
          // start() respawns instead of handing out a dead base URL, and
          // report the exit — but only while this child is still the live
          // one. A superseded child (a workspace switch kills it) and a
          // dispose() kill both still fire exit; reporting those would show
          // a crash banner for a healthy replacement daemon or a panel that
          // is tearing down on purpose.
          if (this.child === child) {
            this.child = null;
            this.runtime = null;
            this.boundWorkspaceCwd = null;
            for (const listener of [...this.exitListeners]) listener();
          }
          return;
        }
        finish(
          new Error(
            `Qwen daemon exited before startup (code=${String(code)}, signal=${String(signal)})${output ? `: ${output.slice(-500)}` : ''}`,
          ),
        );
      });
    });
    return this.startup;
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.runtime = null;
    this.startup = null;
    this.boundWorkspaceCwd = null;
  }
}
