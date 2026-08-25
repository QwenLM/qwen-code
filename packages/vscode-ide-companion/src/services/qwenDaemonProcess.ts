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

const STARTUP_TIMEOUT_MS = 30_000;
const LISTENING_URL = /qwen serve listening on (http:\/\/[^\s]+)/;

export class QwenDaemonProcess {
  private child: ChildProcess | null = null;
  private runtime: QwenDaemonRuntime | null = null;
  private startup: Promise<QwenDaemonRuntime> | null = null;

  start(
    cliEntryPath: string,
    workspaceCwd: string,
  ): Promise<QwenDaemonRuntime> {
    if (this.runtime && this.child && this.child.exitCode === null) {
      return Promise.resolve(this.runtime);
    }
    if (this.startup) return this.startup;

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
      const finish = (error?: Error, baseUrl?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
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

      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = LISTENING_URL.exec(output);
        if (match?.[1]) finish(undefined, match[1]);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        this.child = null;
        this.runtime = null;
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
  }
}
