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
  type ModCommand,
  type ModLog,
  type ModReply,
  type ModRequest,
  type ModSource,
  type ModOptions,
  type ModPlugin,
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
  private commands: Array<ModCommand & { plugin: string }> = [];
  private readonly cancelled = new Int32Array(new SharedArrayBuffer(4));

  private constructor(
    private readonly log: (entry: ModLog, plugin: string) => void,
  ) {
    this.worker = new Worker(workerEntry(), {
      stdout: true,
      stderr: true,
      workerData: this.cancelled.buffer,
    });
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on('message', (reply: ModReply) => {
      if (reply.type === 'log') {
        if (this.failure) return;
        try {
          this.log({ text: reply.text, to: reply.to }, reply.plugin);
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
    source: ModSource,
    cwd: string,
    log: (entry: ModLog) => void,
    signal: AbortSignal,
    options: ModOptions = {},
  ): Promise<ModRuntime> {
    return ModRuntime.createGroup(
      [{ id: 'mod', name: 'mod', source, options }],
      cwd,
      log,
      signal,
    );
  }

  static async createGroup(
    plugins: ModPlugin[],
    cwd: string,
    log: (entry: ModLog, plugin: string) => void,
    signal: AbortSignal,
  ): Promise<ModRuntime> {
    if (
      plugins.length > 32 ||
      new Set(plugins.map((p) => p.id)).size !== plugins.length
    )
      throw new Error('Invalid Mod plugin group.');
    const runtime = new ModRuntime(log);
    try {
      const result = await runtime.request(
        { type: 'load', plugins, cwd },
        signal,
        60_000,
      );
      if (
        !Array.isArray(result) ||
        result.length > 64 ||
        result.some(
          (command) =>
            !command ||
            !plugins.some((plugin) => plugin.id === command.plugin) ||
            typeof command.name !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(command.name) ||
            typeof command.description !== 'string' ||
            (command.argumentHint !== undefined &&
              typeof command.argumentHint !== 'string'),
        )
      )
        throw new Error('Invalid Mod command declarations.');
      runtime.commands = result as Array<ModCommand & { plugin: string }>;
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  getCommands(plugin = 'mod'): readonly ModCommand[] {
    return this.commands
      .filter((command) => command.plugin === plugin)
      .map(({ plugin: _plugin, ...command }) => command);
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
    timeoutMs = 60_000,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('A Mod dispatch is already running.');
    if (
      Buffer.byteLength(JSON.stringify(request)) >
      (request.type === 'load' ? 32 : 1) * MOD_MAX_BYTES + 8192
    )
      throw new Error('Mod request is too large.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = new AbortController();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      Atomics.store(this.cancelled, 0, 1);
    };
    Atomics.store(this.cancelled, 0, 0);
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending = (reply) => {
          if (aborted) reject(new Error('Mod dispatch cancelled.'));
          else if (reply.type === 'error') reject(new Error(reply.message));
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
        timer = setTimeout(() => {
          this.fail(
            new Error(
              aborted ? 'Mod dispatch cancelled.' : 'Mod dispatch timed out.',
            ),
          );
          void this.worker.terminate();
        }, timeoutMs + 250);
        signal.addEventListener(
          'abort',
          () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              this.fail(new Error('Mod dispatch cancelled.'));
              void this.worker.terminate();
            }, 250);
          },
          { once: true, signal: cleanup.signal },
        );
        this.worker.postMessage(request);
      });
    } finally {
      cleanup.abort();
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.pending = undefined;
    }
  }
}
