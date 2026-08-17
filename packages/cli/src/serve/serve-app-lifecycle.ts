/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Server } from 'node:http';
import type { Application } from 'express';
import type { ConversationRuntimeOwnership } from './conversations/conversation-runtime-ownership.js';
import { conversationRuntimeUnavailableError } from './conversations/conversation-runtime-errors.js';

const SERVE_APP_LIFECYCLE = Symbol('qwen.serveAppLifecycle');
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const SECONDARY_CLOSE_TIMEOUT_MS = 2_000;

export interface ServeAppLifecycleBindingOptions {
  startupReady?: Promise<void>;
  drainHost?: () => Promise<void>;
}

export interface ServeAppLifecycle {
  bindServer(server: Server, options?: ServeAppLifecycleBindingOptions): void;
  close(options?: { timeoutMs?: number }): Promise<void>;
}

interface ServeAppLifecycleLocals {
  [SERVE_APP_LIFECYCLE]?: ServeAppLifecycleController;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export class ServeAppLifecycleController implements ServeAppLifecycle {
  private readonly admission = deferred();
  private server?: Server;
  private startupReady = true;
  private listenerReady = false;
  private listenerClosed = false;
  private sealed = false;
  private closePending?: Promise<void>;
  private ownership?: ConversationRuntimeOwnership;
  private appDrain?: () => Promise<void>;
  private hostDrain?: () => Promise<void>;
  private bootStarter?: () => Promise<void> | void;
  private bootPending?: Promise<void>;
  private bootStarted = false;

  bindServer(
    server: Server,
    options: ServeAppLifecycleBindingOptions = {},
  ): void {
    if (this.server || server.listening || this.bootStarted || this.sealed) {
      throw new Error(
        'Serve app lifecycle must bind one server before its first listen.',
      );
    }
    this.server = server;
    this.hostDrain = options.drainHost;
    this.startupReady = options.startupReady === undefined;
    server.once('listening', () => {
      this.listenerReady = true;
      if (this.sealed) {
        server.close();
        server.closeAllConnections();
        return;
      }
      this.openAdmissionIfReady();
    });
    server.on('close', () => {
      this.listenerClosed = true;
      this.seal();
      void this.close().catch(() => undefined);
    });
    server.on('error', (error) => {
      if (!this.listenerReady && options.startupReady === undefined) {
        this.seal(error);
        void this.close().catch(() => undefined);
      }
    });
    if (options.startupReady) {
      void options.startupReady.then(
        () => {
          this.startupReady = true;
          this.openAdmissionIfReady();
        },
        (error: unknown) => {
          this.seal(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }
  }

  close(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.closePending) return this.closePending;
    const pending = this.closeOnce(options);
    this.closePending = pending;
    void pending.catch(() => {
      if (this.closePending === pending) this.closePending = undefined;
    });
    return pending;
  }

  setOwnership(ownership: ConversationRuntimeOwnership): void {
    if (this.ownership) {
      throw new Error('Serve app lifecycle ownership is already configured.');
    }
    this.ownership = ownership;
  }

  setAppDrain(drain: () => Promise<void>): void {
    this.appDrain = drain;
  }

  setBootStarter(starter: () => Promise<void> | void): void {
    this.bootStarter = starter;
    this.openAdmissionIfReady();
  }

  async awaitBootAdmission(): Promise<void> {
    if (!this.server || this.sealed) {
      throw conversationRuntimeUnavailableError();
    }
    try {
      await this.admission.promise;
    } catch (error) {
      throw conversationRuntimeUnavailableError(error);
    }
    if (this.sealed) {
      throw conversationRuntimeUnavailableError();
    }
  }

  async startBoot(starter = this.bootStarter): Promise<void> {
    await this.awaitBootAdmission();
    await this.beginBoot(starter);
  }

  getBootPromise(): Promise<void> | undefined {
    return this.bootPending;
  }

  isBootStarted(): boolean {
    return this.bootStarted;
  }

  sealBoot(): void {
    this.seal();
  }

  private openAdmissionIfReady(): void {
    if (
      this.sealed ||
      !this.server ||
      !this.listenerReady ||
      !this.startupReady
    ) {
      return;
    }
    this.admission.resolve();
    const bootStarter = this.bootStarter;
    if (bootStarter && !this.bootStarted) {
      void this.beginBoot(bootStarter)?.catch(() => undefined);
    }
  }

  private beginBoot(
    starter: (() => Promise<void> | void) | undefined,
  ): Promise<void> | undefined {
    if (!starter) return undefined;
    if (this.sealed) {
      return Promise.reject(conversationRuntimeUnavailableError());
    }
    if (this.bootPending) return this.bootPending;
    this.bootStarted = true;
    const pending = Promise.resolve().then(starter);
    const tracked = pending.finally(() => {
      if (this.bootPending === tracked) this.bootPending = undefined;
    });
    this.bootPending = tracked;
    void tracked.catch(() => undefined);
    return tracked;
  }

  private seal(error?: Error): void {
    if (this.sealed) return;
    this.sealed = true;
    this.admission.reject(error ?? conversationRuntimeUnavailableError());
  }

  private async closeOnce(options: { timeoutMs?: number }): Promise<void> {
    this.seal();
    const drains = [
      this.startDrain(this.appDrain),
      this.startDrain(this.hostDrain),
      this.bootPending?.catch(() => undefined),
    ].filter((value): value is Promise<void> => value !== undefined);
    const listenerClose = this.closeListener(
      options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    );
    const results = await Promise.allSettled([...drains, listenerClose]);
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result) => result.reason as unknown);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Serve app shutdown is incomplete.');
    }
    await this.ownership?.release();
  }

  private startDrain(
    drain: (() => Promise<void>) | undefined,
  ): Promise<void> | undefined {
    if (!drain) return undefined;
    try {
      return drain();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private closeListener(timeoutMs: number): Promise<void> {
    if (
      !this.server ||
      this.listenerClosed ||
      (!this.listenerReady && !this.server.listening)
    ) {
      return Promise.resolve();
    }
    const server = this.server;
    if (!server.listening) {
      return this.waitForClosingListener(server, timeoutMs);
    }
    return new Promise<void>((resolve, reject) => {
      let secondaryTimer: NodeJS.Timeout | undefined;
      const forceTimer = setTimeout(
        () => {
          server.closeAllConnections();
          secondaryTimer = setTimeout(() => {
            reject(new Error('The serve listener did not confirm shutdown.'));
          }, SECONDARY_CLOSE_TIMEOUT_MS);
          secondaryTimer.unref();
        },
        Math.max(0, timeoutMs),
      );
      forceTimer.unref();
      server.close((error) => {
        clearTimeout(forceTimer);
        if (secondaryTimer) clearTimeout(secondaryTimer);
        if (error) reject(error);
        else {
          this.listenerClosed = true;
          resolve();
        }
      });
    });
  }

  private waitForClosingListener(
    server: Server,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let secondaryTimer: NodeJS.Timeout | undefined;
      const onClose = () => {
        server.off('close', onClose);
        clearTimeout(forceTimer);
        if (secondaryTimer) clearTimeout(secondaryTimer);
        this.listenerClosed = true;
        resolve();
      };
      const forceTimer = setTimeout(
        () => {
          server.closeAllConnections();
          secondaryTimer = setTimeout(() => {
            server.off('close', onClose);
            reject(new Error('The serve listener did not confirm shutdown.'));
          }, SECONDARY_CLOSE_TIMEOUT_MS);
          secondaryTimer.unref();
        },
        Math.max(0, timeoutMs),
      );
      forceTimer.unref();
      server.once('close', onClose);
      if (this.listenerClosed) onClose();
    });
  }
}

export function installServeAppLifecycle(
  app: Application,
  lifecycle = new ServeAppLifecycleController(),
): ServeAppLifecycleController {
  const locals = app.locals as ServeAppLifecycleLocals;
  if (locals[SERVE_APP_LIFECYCLE]) {
    throw new Error('Serve app lifecycle is already installed.');
  }
  locals[SERVE_APP_LIFECYCLE] = lifecycle;
  return lifecycle;
}

export function getServeAppLifecycle(app: Application): ServeAppLifecycle {
  const lifecycle = (app.locals as ServeAppLifecycleLocals)[
    SERVE_APP_LIFECYCLE
  ];
  if (!lifecycle) {
    throw new Error('Application was not created by createServeApp.');
  }
  return lifecycle;
}

export function getServeAppLifecycleController(
  app: Application,
): ServeAppLifecycleController {
  const lifecycle = getServeAppLifecycle(app);
  return lifecycle as ServeAppLifecycleController;
}
