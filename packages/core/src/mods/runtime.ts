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
import { ToolNames } from '../tools/tool-names.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import {
  ModBudget,
  assertModDepth,
  record,
  validateResult,
} from './dispatch.js';
import type {
  ModToolCallInput,
  ModToolNext,
  ModToolCheckResult,
  ModToolResult,
} from './tool-events.js';
import {
  MOD_END_TIMEOUT_MS,
  MOD_MAX_BYTES,
  type ModCommand,
  type ModCommandPresentation,
  type ModLog,
  type ModReply,
  type ModRequest,
  type ModSessionFacts,
  type ModWorkerReply,
  type ModSource,
  type ModOptions,
  type ModPlugin,
} from './types.js';

type ModToolResolver = (
  name: string,
) => Promise<AnyDeclarativeTool | undefined>;

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
  private tools = false;
  private sequence = 0;
  private root?: {
    id: number;
    native?: number;
    idle?: number;
    revision: number;
    phase: number;
    refresh: () => void;
  };
  private tool?: {
    next: ModToolNext;
    controller: AbortController;
    operations: Map<
      number,
      { controller: AbortController; task: Promise<void> }
    >;
    checks: Map<
      number,
      (reply: Extract<ModReply, { type: 'check-result' }>) => void
    >;
    tail: Promise<void>;
  };
  private readonly cancelled = new Int32Array(new SharedArrayBuffer(4));

  private constructor(
    private readonly log: (entry: ModLog, plugin: string) => void,
    private readonly facts: () => ModSessionFacts,
    private readonly resolveTool?: ModToolResolver,
    private readonly surface: 'terminal' | null = null,
  ) {
    this.worker = new Worker(workerEntry(), {
      stdout: true,
      stderr: true,
      workerData: this.cancelled.buffer,
    });
    this.worker.stdout?.resume();
    this.worker.stderr?.resume();
    this.worker.on('message', (reply: ModWorkerReply) => {
      const root = this.root;
      if (!root || reply.root !== root.id) return;
      if (reply.type === 'host-call') this.executeHost(reply);
      else if (reply.type === 'host-cancel') {
        for (const id of reply.ids)
          this.tool?.operations.get(id)?.controller.abort();
      } else if (reply.type === 'check-result')
        this.tool?.checks.get(reply.id)?.(reply);
      else if (reply.type === 'activity') {
        if (
          reply.phase !== root.phase ||
          reply.revision <= root.revision ||
          (reply.operation !== undefined && reply.operation !== root.native)
        )
          return;
        root.revision = reply.revision;
        root.idle = this.tool?.checks.size ? undefined : reply.operation;
        root.refresh();
      } else if (reply.type === 'log') {
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
    resolveTool?: ModToolResolver,
    surface: 'terminal' | null = null,
    version = 'unknown',
    facts?: () => ModSessionFacts,
  ): Promise<ModRuntime> {
    if (
      plugins.length > 32 ||
      new Set(plugins.map((p) => p.id)).size !== plugins.length
    )
      throw new Error('Invalid Mod plugin group.');
    const startedAt = Date.now();
    const runtime = new ModRuntime(
      log,
      facts ??
        (() => ({
          id: '',
          cwd,
          root: cwd,
          model: '',
          turns: 0,
          usage: {
            startedAt,
            context: { tokens: 0, window: 0 },
            rateLimits: [],
          },
        })),
      plugins.some((plugin) => plugin.toolDialect === 'claude')
        ? resolveTool
        : undefined,
      surface,
    );
    try {
      const result = await runtime.request(
        { type: 'load', plugins, cwd, surface, version },
        signal,
        60_000,
      );
      if (!record(result) || typeof result['tools'] !== 'boolean')
        throw new Error('Invalid Mod declarations.');
      const commands = result['commands'];
      if (
        !Array.isArray(commands) ||
        commands.length > 64 ||
        commands.some(
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
      runtime.commands = commands as Array<ModCommand & { plugin: string }>;
      runtime.tools = result['tools'];
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

  get hasToolHooks(): boolean {
    return this.tools;
  }

  private async builtinTool(name: string): Promise<string | undefined> {
    if (!this.resolveTool) return undefined;
    let builtin = false;
    switch (name) {
      case ToolNames.SHELL:
        builtin =
          (await this.resolveTool(name)) instanceof
          (await import('../tools/shell.js')).ShellTool;
        break;
      case ToolNames.EDIT:
        builtin =
          (await this.resolveTool(name)) instanceof
          (await import('../tools/edit.js')).EditTool;
        break;
      case ToolNames.WRITE_FILE:
        builtin =
          (await this.resolveTool(name)) instanceof
          (await import('../tools/write-file.js')).WriteFileTool;
        break;
      default:
        return undefined;
    }
    return builtin ? name : undefined;
  }

  async runTool(
    input: ModToolCallInput,
    next: ModToolNext,
    signal: AbortSignal,
  ): Promise<ModToolResult> {
    if (this.tool || this.pending)
      throw new Error('A Mod dispatch is already running.');
    const owner: NonNullable<ModRuntime['tool']> = {
      next,
      controller: new AbortController(),
      operations: new Map(),
      checks: new Map(),
      tail: Promise.resolve(),
    };
    this.tool = owner;
    try {
      const builtinTool = await this.builtinTool(input.tool);
      const result = await this.request(
        { type: 'tool', input, builtinTool },
        AbortSignal.any([signal, owner.controller.signal]),
      );
      validateResult('tool.call', result);
      return result as ModToolResult;
    } finally {
      owner.controller.abort();
      await Promise.allSettled(
        [...owner.operations.values()].map((operation) => operation.task),
      );
      this.tool = undefined;
    }
  }

  private executeHost(reply: Extract<ModReply, { type: 'host-call' }>): void {
    const owner = this.tool;
    const root = this.root;
    if (
      !owner ||
      !root ||
      owner.operations.size >= 32 ||
      owner.operations.has(reply.id)
    ) {
      this.fail(new Error('Invalid Mod host operation.'));
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      owner.controller.signal,
      controller.signal,
    ]);
    const task = owner.tail
      .then(async () => {
        signal.throwIfAborted();
        root.native = reply.id;
        root.phase++;
        root.idle = undefined;
        root.refresh();
        this.post({ type: 'native', id: reply.id }, root.id);
        const result = await owner.next(
          reply.input,
          signal,
          async (input, verdict, checkSignal) => {
            const active = AbortSignal.any([signal, checkSignal]);
            active.throwIfAborted();
            const id = ++this.sequence;
            let abort: () => void = () => {};
            try {
              return await new Promise<ModToolCheckResult>(
                (resolve, reject) => {
                  abort = () =>
                    reject(new Error('Mod permission check cancelled.'));
                  owner.checks.set(id, (response) => {
                    if (response.error !== undefined)
                      reject(new Error(response.error));
                    else {
                      try {
                        validateResult('tool.check', response.result);
                        resolve({
                          ...response.result!,
                          ceiling: input.ceiling,
                        });
                      } catch (error) {
                        reject(error);
                      }
                    }
                  });
                  root.idle = undefined;
                  root.phase++;
                  root.refresh();
                  active.addEventListener('abort', abort, { once: true });
                  this.post(
                    {
                      type: 'tool-check',
                      id,
                      operation: reply.id,
                      input,
                      verdict,
                    },
                    root.id,
                  );
                },
              );
            } finally {
              active.removeEventListener('abort', abort);
              owner.checks.delete(id);
              root.refresh();
            }
          },
        );
        root.native = undefined;
        root.phase++;
        root.idle = undefined;
        root.refresh();
        signal.throwIfAborted();
        this.post({ type: 'host-result', id: reply.id, result }, root.id);
      })
      .catch((error: unknown) => {
        root.native = undefined;
        root.phase++;
        root.idle = undefined;
        root.refresh();
        if (!this.failure)
          this.post(
            {
              type: 'host-result',
              id: reply.id,
              error: String(error).slice(0, 4000),
            },
            root.id,
          );
      })
      .finally(() => {
        owner.operations.delete(reply.id);
      });
    owner.operations.set(reply.id, { controller, task });
    owner.tail = task;
  }

  private post(request: ModRequest, root: number): void {
    if (this.root?.id !== root) return;
    const json = JSON.stringify(request);
    if (Buffer.byteLength(json) > MOD_MAX_BYTES + 8192)
      throw new Error('Mod host message is too large.');
    assertModDepth(json, 'Mod host message');
    this.worker.postMessage({ ...request, root, phase: this.root.phase });
  }

  async runCommand(
    command: string,
    args: string,
    signal: AbortSignal,
    presentation?: ModCommandPresentation,
  ): Promise<string> {
    if (!this.commands.some((item) => item.name === command))
      throw new Error('Unknown Mod command.');
    const result = await this.request(
      {
        type: 'command',
        command,
        args,
        ...(this.surface === 'terminal' && presentation
          ? { presentation }
          : {}),
      },
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
    await Promise.allSettled(
      [...(this.tool?.operations.values() ?? [])].map(
        (operation) => operation.task,
      ),
    );
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.tool?.controller.abort();
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
    const message = { ...request, facts: this.facts() };
    const json = JSON.stringify(message);
    if (
      Buffer.byteLength(json) >
      (request.type === 'load' ? 32 : 1) * MOD_MAX_BYTES + 8192
    )
      throw new Error('Mod request is too large.');
    assertModDepth(json, 'Mod request');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const budget = new ModBudget(timeoutMs + 250);
    const stop = () => {
      this.fail(
        new Error(
          aborted ? 'Mod dispatch cancelled.' : 'Mod dispatch timed out.',
        ),
      );
      void this.worker.terminate();
    };
    const root: NonNullable<ModRuntime['root']> = {
      id: ++this.sequence,
      revision: 0,
      phase: 0,
      refresh: () => {
        if (aborted || this.root !== root) return;
        const lending =
          request.type === 'tool' &&
          root.native !== undefined &&
          root.idle === root.native &&
          !this.tool?.checks.size &&
          !budget.expired;
        if (lending !== budget.lending) {
          if (lending) budget.pause();
          else budget.resume();
        }
        if (timer) clearTimeout(timer);
        if (!budget.lending) timer = setTimeout(stop, budget.remainingMs);
      },
    };
    this.root = root;
    const onAbort = () => {
      aborted = true;
      Atomics.store(this.cancelled, 0, 1);
      this.tool?.controller.abort();
      if (timer) clearTimeout(timer);
      cancelTimer = setTimeout(stop, 250);
    };
    Atomics.store(this.cancelled, 0, 0);
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending = (reply) => {
          if (this.failure) reject(this.failure);
          else if (aborted) reject(new Error('Mod dispatch cancelled.'));
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
        root.refresh();
        this.worker.postMessage({
          ...message,
          root: root.id,
          phase: root.phase,
        });
      });
    } finally {
      this.root = undefined;
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onAbort);
      this.pending = undefined;
    }
  }
}
