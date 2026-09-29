/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  ProcessRegistry,
  ProcessExitError,
  type TrackedChildProcess,
} from '@qwen-code/acp-bridge';
import {
  MANAGED_RUNTIME_STARTUP_MS,
  ManagedRuntimeReleasedError,
  type ManagedRuntimeEndpoint,
  type ManagedRuntimeScope,
  type ManagedRuntimeUse,
  type ManagedWorkerBoot,
} from './managed-runtime-activator.js';
import { ManagedRuntimeProviderError } from './managed-runtime-provider.js';
import type { WorkspaceRuntime } from './workspace-registry.js';

export interface LocalProcessRuntimeActivatorOptions {
  readonly stateDir: string;
  readonly cliEntry: string;
  readonly launcher: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly maxWorkers?: number;
  readonly startupMs?: number;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}
interface Generation {
  readonly key: string;
  readonly scope: ManagedRuntimeScope;
  readonly boot: ManagedWorkerBoot;
  readonly controller: AbortController;
  readonly uses: Set<symbol>;
  readonly exited: Promise<void>;
  readonly resolveExit: () => void;
  readonly rejectExit: (error: unknown) => void;
  endpoint: Promise<ManagedRuntimeEndpoint>;
  child?: ChildProcess;
  tracked?: TrackedChildProcess;
  stop?: Promise<void>;
  ready: boolean;
  retiring: boolean;
  operations: number;
  lastUsed: number;
  readonly startedAt: number;
}

export function managedWorkerEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      /^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TMP|TEMP|TMPDIR|LANG|LC_[A-Z_]+|TZ|WSL_INTEROP|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy|QWEN_HOME|QWEN_CODE_TRUSTED_FOLDERS_PATH)$/.test(
        key,
      )
    )
      result[key] = value;
  }
  for (const key of ['QWEN_HOME', 'QWEN_CODE_TRUSTED_FOLDERS_PATH']) {
    if (result[key]) result[key] = path.resolve(result[key]);
  }
  return result;
}

export class LocalProcessRuntimeActivator {
  private readonly incarnation = randomUUID();
  private readonly registry = new ProcessRegistry();
  private readonly generations = new Map<string, Generation>();
  private readonly epochs = new Map<string, number>();
  private readonly draining = new Set<WorkspaceRuntime>();
  private readonly revoked = new Set<WorkspaceRuntime>();
  private readonly reloading = new Set<WorkspaceRuntime>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: LocalProcessRuntimeActivatorOptions) {}

  activate(scope: ManagedRuntimeScope): ManagedRuntimeUse {
    const key = JSON.stringify([
      scope.tenantId,
      scope.runtime.workspaceId,
      scope.runtime.workspaceCwd,
    ]);
    let generation = this.generations.get(key);
    if (
      this.closed ||
      this.draining.has(scope.runtime) ||
      this.revoked.has(scope.runtime) ||
      this.reloading.has(scope.runtime) ||
      generation?.retiring ||
      (generation && generation.scope.runtime !== scope.runtime)
    ) {
      return this.unavailable('managed_runtime_unavailable');
    }
    if (!generation) {
      const limit = this.options.maxWorkers ?? 4;
      let eviction: Promise<void> | undefined;
      if (this.generations.size > limit)
        return this.unavailable('managed_runtime_capacity_exhausted');
      if (this.generations.size >= limit) {
        const idle = [...this.generations.values()]
          .filter((g) => !g.retiring && g.uses.size === 0 && g.operations === 0)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle)
          return this.unavailable('managed_runtime_capacity_exhausted');
        eviction = this.stop(
          idle,
          new ManagedRuntimeReleasedError('Managed Runtime evicted.'),
        );
      }
      const epoch = (this.epochs.get(key) ?? 0) + 1;
      this.epochs.set(key, epoch);
      const leaseId = randomUUID();
      let resolveExit!: () => void;
      let rejectExit!: (error: unknown) => void;
      const exited = new Promise<void>((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });
      void exited.catch(() => {});
      generation = {
        key,
        scope,
        boot: {
          type: 'boot',
          cliEntry: this.options.cliEntry,
          version: 1,
          gatewayIncarnation: this.incarnation,
          leaseId,
          epoch,
          tenantId: scope.tenantId,
          workspaceId: scope.runtime.workspaceId,
          workspaceCwd: scope.runtime.workspaceCwd,
          token: randomBytes(32).toString('hex'),
          outputRoot: path.join(this.options.stateDir, 'workers', leaseId),
        },
        controller: new AbortController(),
        uses: new Set(),
        exited,
        resolveExit,
        rejectExit,
        endpoint: Promise.resolve(undefined as never),
        ready: false,
        retiring: false,
        operations: 0,
        lastUsed: Date.now(),
        startedAt: Date.now(),
      };
      setMaxListeners(0, generation.controller.signal);
      this.generations.set(key, generation);
      const active = generation;
      active.endpoint = this.start(active, eviction);
      void active.endpoint.catch((error) => {
        void this.stop(
          active,
          error instanceof Error
            ? error
            : new Error('Managed Runtime startup failed.'),
        ).catch(() => {});
      });
    } else this.log(generation, 'reuse');
    const active = generation;
    const id = Symbol('runtime-use');
    active.uses.add(id);
    let released = false;
    const prepareDeadline = active.ready
      ? Date.now() + (this.options.startupMs ?? MANAGED_RUNTIME_STARTUP_MS)
      : undefined;
    return {
      endpoint: active.endpoint.then((endpoint) =>
        prepareDeadline === undefined
          ? endpoint
          : { ...endpoint, deadline: prepareDeadline },
      ),
      signal: active.controller.signal,
      exited: active.exited,
      release: (reason) => {
        if (released) return;
        released = true;
        active.uses.delete(id);
        active.lastUsed = Date.now();
        if (
          active.uses.size === 0 &&
          (active.retiring || (!active.ready && reason !== 'completed'))
        ) {
          void this.stop(
            active,
            new ManagedRuntimeReleasedError('Managed Runtime use ended.'),
          ).catch(() => {});
        }
      },
      beginOperation: () => {
        active.controller.signal.throwIfAborted();
        active.operations++;
        let state: 'active' | 'uncertain' | 'finished' = 'active';
        return (certain) => {
          if (state === 'finished') return;
          if (certain) {
            state = 'finished';
            active.operations--;
          } else {
            state = 'uncertain';
            active.retiring = true;
          }
          if (active.retiring && active.uses.size === 0)
            void this.stop(
              active,
              new ManagedRuntimeReleasedError(
                'Managed Runtime uncertain execution contained.',
              ),
            ).catch(() => {});
        };
      },
    };
  }

  beginDrain(runtime: WorkspaceRuntime): void {
    this.draining.add(runtime);
  }
  cancelDrain(runtime: WorkspaceRuntime): void {
    this.draining.delete(runtime);
  }
  workspaceActivity(runtime: WorkspaceRuntime): number {
    return [...this.generations.values()]
      .filter((g) => g.scope.runtime === runtime)
      .reduce((n, g) => n + g.uses.size + g.operations, 0);
  }
  revokeWorkspace(runtime: WorkspaceRuntime): Promise<void> {
    this.revoked.add(runtime);
    return this.stopWorkspace(runtime);
  }
  reloadWorkspace(runtime: WorkspaceRuntime): Promise<void> {
    this.reloading.add(runtime);
    return this.stopWorkspace(runtime);
  }
  completeReload(runtime: WorkspaceRuntime): void {
    this.reloading.delete(runtime);
  }
  private async stopWorkspace(runtime: WorkspaceRuntime): Promise<void> {
    await Promise.all(
      [...this.generations.values()]
        .filter((g) => g.scope.runtime === runtime)
        .map((g) =>
          this.stop(
            g,
            new ManagedRuntimeReleasedError(
              'Managed Runtime workspace invalidated.',
            ),
          ),
        ),
    );
  }
  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= Promise.all(
      [...this.generations.values()].map((g) =>
        this.stop(
          g,
          new ManagedRuntimeReleasedError('Managed Runtime Gateway stopped.'),
        ),
      ),
    ).then(() => this.registry.shutdown());
    return this.closePromise;
  }
  killAllSync(): void {
    this.closed = true;
    this.registry.killAllSync();
  }

  private unavailable(
    code: 'managed_runtime_capacity_exhausted' | 'managed_runtime_unavailable',
  ): ManagedRuntimeUse {
    this.options.log(code, {});
    const endpoint = Promise.reject<ManagedRuntimeEndpoint>(
      new ManagedRuntimeProviderError(
        code,
        'Managed Runtime cannot accept a new use.',
        true,
      ),
    );
    void endpoint.catch(() => {});
    return {
      endpoint,
      signal: new AbortController().signal,
      exited: Promise.resolve(),
      release: () => {},
      beginOperation: () => () => {},
    };
  }
  private async start(
    g: Generation,
    eviction?: Promise<void>,
  ): Promise<ManagedRuntimeEndpoint> {
    const deadline =
      g.startedAt + (this.options.startupMs ?? MANAGED_RUNTIME_STARTUP_MS);
    await eviction;
    g.controller.signal.throwIfAborted();
    await mkdir(g.boot.outputRoot, { recursive: true, mode: 0o700 });
    g.controller.signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error('Managed Runtime startup timed out.');
    let endpointUrl: string | undefined;
    const reservation = this.registry.reserve();
    try {
      const child = spawn(process.execPath, [...this.options.launcher], {
        cwd: g.boot.workspaceCwd,
        env: managedWorkerEnvironment(this.options.env),
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      g.child = child;
      g.tracked = reservation.attach(child, { ownsProcessTree: true });
      // Drain without echoing arbitrary worker output (which may contain secrets).
      child.stdout?.resume();
      child.stderr?.resume();
      child.once('exit', () => {
        if (!g.retiring)
          void this.stop(
            g,
            new Error('Managed Runtime worker exited unexpectedly.'),
          ).catch(() => {});
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => done(new Error('Managed Runtime startup timed out.')),
          Math.max(0, deadline - Date.now()),
        );
        const aborted = () => done(g.controller.signal.reason);
        const error = () =>
          done(new Error('Managed Runtime worker could not start.'));
        const exited = () =>
          done(new Error('Managed Runtime worker exited during startup.'));
        const message = (value: unknown) => {
          const ready = value as Partial<Omit<ManagedWorkerBoot, 'type'>> & {
            type?: string;
            url?: unknown;
          };
          if (
            ready?.type !== 'ready' ||
            ready.version !== 1 ||
            ready.leaseId !== g.boot.leaseId ||
            ready.epoch !== g.boot.epoch ||
            ready.gatewayIncarnation !== this.incarnation ||
            ready.workspaceId !== g.boot.workspaceId ||
            ready.workspaceCwd !== g.boot.workspaceCwd ||
            ready.tenantId !== g.boot.tenantId ||
            typeof ready.url !== 'string'
          )
            return done(
              new Error(
                'Managed Runtime worker returned an invalid handshake.',
              ),
            );
          let url: URL;
          try {
            url = new URL(ready.url);
          } catch {
            done(new Error('Managed Runtime worker returned an invalid URL.'));
            return;
          }
          if (
            url.protocol !== 'http:' ||
            url.hostname !== '127.0.0.1' ||
            !url.port ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
          )
            return done(
              new Error('Managed Runtime worker returned an invalid endpoint.'),
            );
          endpointUrl = url.origin;
          done();
        };
        const done = (error?: unknown) => {
          clearTimeout(timer);
          g.controller.signal.removeEventListener('abort', aborted);
          child.removeListener('message', message);
          child.removeListener('error', errorHandler);
          child.removeListener('exit', exited);
          if (error) reject(error);
          else resolve();
        };
        const errorHandler = error;
        child.on('message', message);
        child.once('error', errorHandler);
        child.once('exit', exited);
        g.controller.signal.addEventListener('abort', aborted, { once: true });
        if (g.controller.signal.aborted) aborted();
        else
          child.send(g.boot, (err) => {
            if (err) error();
          });
      });
      g.controller.signal.throwIfAborted();
      g.ready = true;
      this.log(g, 'started');
      return { url: endpointUrl!, boot: g.boot, deadline };
    } finally {
      reservation.cancel();
    }
  }
  private stop(g: Generation, reason: Error): Promise<void> {
    if (g.stop) return g.stop;
    g.retiring = true;
    g.controller.abort(reason);
    g.stop = (async () => {
      await g.endpoint.catch(() => {});
      if (g.tracked) {
        try {
          await g.tracked.terminate();
        } catch (error) {
          if (!(error instanceof ProcessExitError)) throw error;
          this.log(g, 'terminated');
        }
      }
      await rm(g.boot.outputRoot, { recursive: true, force: true });
      if (this.generations.get(g.key) === g) this.generations.delete(g.key);
      this.log(g, 'released');
      g.resolveExit();
    })().catch((error) => {
      g.rejectExit(error);
      this.log(g, 'cleanup_failed');
      throw error;
    });
    return g.stop;
  }
  private log(g: Generation, event: string): void {
    this.options.log(event, {
      workspaceId: g.boot.workspaceId,
      generation: g.boot.epoch,
      elapsedMs: Date.now() - g.startedAt,
      pid: g.child?.pid,
    });
  }
}
