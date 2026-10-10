/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import {
  MOD_END_TIMEOUT_MS,
  MOD_MAX_BYTES,
  MOD_TIMEOUT_MS,
  type ModCommand,
  type ModLog,
  type ModReply,
  type ModRequest,
} from './types.js';

function workerEntry(): URL | string {
  if (import.meta.url.endsWith('.ts')) {
    return new URL(
      `data:text/javascript,${encodeURIComponent(
        `import { register } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; register(); await import(${JSON.stringify(new URL('./mod-worker.ts', import.meta.url).href)});`,
      )}`,
    );
  }
  const sibling = new URL('./mod-worker.js', import.meta.url);
  return existsSync(sibling)
    ? sibling
    : path.join(resolveBundleDir(import.meta.url), 'mod-worker.js');
}

export class ModRuntime {
  private readonly worker: Worker;
  private failure?: Error;
  private pending?: (reply: ModReply) => void;
  private commands: ModCommand[] = [];

  private constructor(private readonly log: (entry: ModLog) => void) {
    this.worker = new Worker(workerEntry(), { stdout: true, stderr: true });
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on('message', (reply: ModReply) => {
      if (reply.type === 'log') {
        if (this.failure) return;
        try {
          this.log({ text: reply.text, to: reply.to });
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          void this.worker.terminate();
        }
      } else this.pending?.(reply);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) =>
      this.fail(new Error(`Mod worker exited (${code}).`)),
    );
  }

  static async create(
    source: string,
    cwd: string,
    log: (entry: ModLog) => void,
    signal: AbortSignal,
  ): Promise<ModRuntime> {
    const runtime = new ModRuntime(log);
    try {
      const result = await runtime.request(
        { type: 'load', source, cwd },
        signal,
        30_000,
      );
      if (
        !Array.isArray(result) ||
        result.length > 64 ||
        result.some(
          (command) =>
            !command ||
            typeof command.name !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(command.name) ||
            typeof command.description !== 'string' ||
            (command.argumentHint !== undefined &&
              typeof command.argumentHint !== 'string'),
        )
      )
        throw new Error('Invalid Mod command declarations.');
      runtime.commands = result as ModCommand[];
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  getCommands(): readonly ModCommand[] {
    return this.commands;
  }

  async runCommand(
    command: string,
    args: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!this.commands.some((item) => item.name === command))
      throw new Error('Unknown Mod command.');
    const result = await this.request(
      { type: 'command', command, args },
      signal,
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Object.keys(result).some((key) => key !== 'text') ||
      ('text' in result && typeof result.text !== 'string')
    ) {
      throw new Error('Invalid Mod command result.');
    }
    return 'text' in result ? (result.text as string) : '';
  }

  async end(
    sessionId: string,
    reason: 'clear' | 'resume' | 'other',
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(
      { type: 'end', sessionId, reason },
      signal,
      MOD_END_TIMEOUT_MS,
    );
  }

  async dispose(): Promise<void> {
    this.fail(new Error('Mod runtime is closed.'));
    await this.worker.terminate();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.pending?.({ type: 'error', message: this.failure.message });
  }

  private async request(
    request: ModRequest,
    signal: AbortSignal,
    timeoutMs = MOD_TIMEOUT_MS,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('A Mod dispatch is already running.');
    if (Buffer.byteLength(JSON.stringify(request)) > MOD_MAX_BYTES + 8192)
      throw new Error('Mod request is too large.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => this.fail(new Error('Mod dispatch cancelled.'));
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending = (reply) => {
          if (reply.type === 'error') reject(new Error(reply.message));
          else if (reply.type === 'result') {
            try {
              if (Buffer.byteLength(reply.json) > MOD_MAX_BYTES)
                throw new Error('Mod reply is too large.');
              resolve(JSON.parse(reply.json));
            } catch (error) {
              reject(error);
            }
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(
          () => this.fail(new Error('Mod dispatch timed out.')),
          timeoutMs,
        );
        this.worker.postMessage(request);
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      void this.worker.terminate();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.pending = undefined;
    }
  }
}
