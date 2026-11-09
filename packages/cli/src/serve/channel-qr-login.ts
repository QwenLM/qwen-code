/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { ChannelQrLoginDescriptor } from '@qwen-code/channel-base';

/** How long a login may stay open before the sweeper reclaims it. */
export const CHANNEL_QR_LOGIN_TTL_MS = 5 * 60_000;
export const CHANNEL_QR_LOGIN_SWEEP_INTERVAL_MS = 30_000;
/** Per-workspace ceiling; a login is interactive so a handful is plenty. */
export const CHANNEL_QR_LOGIN_MAX_ACTIVE = 4;

export type ChannelQrLoginStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled';

/**
 * Wire shape. Deliberately carries no credential values: the adapter hands them
 * to `persist` inside the daemon, and the browser only learns that binding
 * succeeded so it can reload the channel snapshot.
 */
export interface ChannelQrLoginView {
  loginId: string;
  channelType: string;
  channelName: string;
  status: ChannelQrLoginStatus;
  expiresAt: number;
  qrCodeDataUrl?: string;
  error?: string;
}

interface ChannelQrLoginEntry {
  view: ChannelQrLoginView;
  abort: AbortController;
  dispose?: () => void;
  initiatorClientId?: string;
}

export class TooManyChannelQrLoginsError extends Error {
  readonly code = 'channel_qr_login_limit_reached';

  constructor() {
    super('Too many active channel QR logins for this workspace.');
    this.name = 'TooManyChannelQrLoginsError';
  }
}

export interface ChannelQrLoginRegistryDeps {
  /** Render a QR payload into an image the browser can display directly. */
  renderQrCode(url: string): Promise<string>;
  /** Persist adapter-supplied values, keyed by management field key. */
  persist(
    channelName: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void>;
  now?: () => number;
  scheduleInterval?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearScheduledInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Ephemeral, workspace-scoped QR login sessions. Owned by a
 * ChannelManagementService rather than a process-global singleton: the login
 * completes by writing one workspace's channel config, so scoping it here makes
 * cross-workspace access impossible by construction and lets the owning
 * service's lifetime reclaim the sessions.
 */
export class ChannelQrLoginRegistry {
  private readonly entries = new Map<string, ChannelQrLoginEntry>();
  private readonly now: () => number;
  private readonly scheduleInterval: NonNullable<
    ChannelQrLoginRegistryDeps['scheduleInterval']
  >;
  private sweeperHandle?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: ChannelQrLoginRegistryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.scheduleInterval =
      deps.scheduleInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.sweeperHandle = this.scheduleInterval(
      () => this.sweep(),
      CHANNEL_QR_LOGIN_SWEEP_INTERVAL_MS,
    );
    // Best-effort GC; never hold the process open for an abandoned login.
    const handle = this.sweeperHandle as { unref?: () => void } | undefined;
    handle?.unref?.();
  }

  /** Same-client reattach is idempotent, mirroring the device-flow contract. */
  start(options: {
    channelType: string;
    channelName: string;
    qrLogin: ChannelQrLoginDescriptor;
    initiatorClientId?: string;
  }): { view: ChannelQrLoginView; attached: boolean } {
    const existing = [...this.entries.values()].find(
      (entry) =>
        entry.view.channelName === options.channelName &&
        entry.view.status === 'pending' &&
        entry.view.expiresAt > this.now() &&
        entry.initiatorClientId === options.initiatorClientId,
    );
    if (existing) return { view: { ...existing.view }, attached: true };

    const active = [...this.entries.values()].filter(
      (entry) =>
        entry.view.status === 'pending' && entry.view.expiresAt > this.now(),
    ).length;
    if (active >= CHANNEL_QR_LOGIN_MAX_ACTIVE) {
      throw new TooManyChannelQrLoginsError();
    }

    const loginId = randomUUID();
    const abort = new AbortController();
    const entry: ChannelQrLoginEntry = {
      view: {
        loginId,
        channelType: options.channelType,
        channelName: options.channelName,
        status: 'pending',
        expiresAt: this.now() + CHANNEL_QR_LOGIN_TTL_MS,
      },
      abort,
      ...(options.initiatorClientId !== undefined
        ? { initiatorClientId: options.initiatorClientId }
        : {}),
    };
    this.entries.set(loginId, entry);

    const terminal = (status: ChannelQrLoginStatus, error?: string): void => {
      if (entry.view.status !== 'pending') return;
      entry.view.status = status;
      if (error !== undefined) entry.view.error = error;
      // A terminal login must not keep a scannable code on screen.
      delete entry.view.qrCodeDataUrl;
      this.stop(entry);
    };

    try {
      entry.dispose = options.qrLogin.start(
        {
          onQrCode: (url) => {
            if (entry.view.status !== 'pending') return;
            void this.deps
              .renderQrCode(url)
              .then((dataUrl) => {
                if (entry.view.status !== 'pending') return;
                entry.view.qrCodeDataUrl = dataUrl;
              })
              .catch((renderError: unknown) => {
                terminal('failed', message(renderError));
              });
          },
          onExpired: () => {
            // The adapter requests a replacement code; stay pending and drop
            // the stale image so the UI cannot show an unscannable one.
            if (entry.view.status !== 'pending') return;
            delete entry.view.qrCodeDataUrl;
          },
          onSuccess: (values) => {
            if (entry.view.status !== 'pending') return;
            void this.deps
              .persist(options.channelName, values)
              .then(() => terminal('succeeded'))
              .catch((persistError: unknown) => {
                terminal('failed', message(persistError));
              });
          },
          onFailure: (error) => terminal('failed', message(error)),
        },
        abort.signal,
      );
    } catch (startError) {
      terminal('failed', message(startError));
    }

    return { view: { ...entry.view }, attached: false };
  }

  get(
    loginId: string,
    callerClientId?: string,
  ): ChannelQrLoginView | undefined {
    const entry = this.entries.get(loginId);
    if (!entry) return undefined;
    this.expireIfDue(entry);
    const view = { ...entry.view };
    // The QR payload binds whichever bot scans it, so only the initiating
    // client may read it. Best-effort attribution, not authentication: the
    // bearer token remains the auth boundary.
    if (
      entry.initiatorClientId !== undefined &&
      entry.initiatorClientId !== callerClientId
    ) {
      delete view.qrCodeDataUrl;
    }
    return view;
  }

  cancel(loginId: string, callerClientId?: string): boolean {
    const entry = this.entries.get(loginId);
    if (!entry) return false;
    if (
      entry.initiatorClientId !== undefined &&
      entry.initiatorClientId !== callerClientId
    ) {
      return false;
    }
    if (entry.view.status === 'pending') {
      entry.view.status = 'cancelled';
      delete entry.view.qrCodeDataUrl;
      this.stop(entry);
    }
    return true;
  }

  /** Stop every session; used when the owning service is torn down. */
  dispose(): void {
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
    if (this.sweeperHandle !== undefined) {
      (this.deps.clearScheduledInterval ?? ((handle) => clearInterval(handle)))(
        this.sweeperHandle,
      );
      this.sweeperHandle = undefined;
    }
  }

  private stop(entry: ChannelQrLoginEntry): void {
    entry.abort.abort();
    try {
      entry.dispose?.();
    } catch {
      // A misbehaving adapter must not block session teardown.
    }
    entry.dispose = undefined;
  }

  private expireIfDue(entry: ChannelQrLoginEntry): void {
    if (entry.view.status !== 'pending' || this.now() < entry.view.expiresAt) {
      return;
    }
    entry.view.status = 'expired';
    delete entry.view.qrCodeDataUrl;
    this.stop(entry);
  }

  private sweep(): void {
    for (const entry of this.entries.values()) this.expireIfDue(entry);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
