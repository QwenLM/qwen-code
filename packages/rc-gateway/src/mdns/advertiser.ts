/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin wrapper around the optional `bonjour-service` library (add-mdns-discovery
 * D1). The bonjour instance is INJECTED via a factory so the publish/Goodbye
 * lifecycle is unit-tested against a fake — the live multicast publish is a
 * verification ceiling (needs a real LAN socket, frequently broken under WSL2).
 *
 * Goodbye (design D4): on shutdown we call `unpublishAll` (which sends Goodbye
 * packets) and wait up to `timeoutMs` for it before destroying the socket, so a
 * stale record does not haunt the LAN for the 75-minute mDNS TTL.
 */

import type { TxtRecord } from './advert.js';

/** The DNS-SD service type (library forms `_qwen-rc._tcp.local.` from this). */
export const QWEN_RC_SERVICE_TYPE = 'qwen-rc';

/**
 * Log keyword emitted (as a `console.warn` prefix) when the optional
 * `bonjour-service` package is not installed and mDNS advertisement is
 * silently skipped. Pinned to this exact string so monitors / grep-verify
 * tests can detect the condition without coupling to the full prose message.
 */
export const MDNS_UNAVAILABLE_KEYWORD = 'mdns_unavailable';

/** A published service handle (we only ever destroy via the parent instance). */
export interface BonjourServiceLike {
  stop?(cb?: () => void): void;
}

/** The minimal `bonjour-service` surface we depend on. */
export interface BonjourLike {
  publish(opts: {
    name: string;
    type: string;
    port: number;
    txt: Record<string, string>;
  }): BonjourServiceLike;
  unpublishAll(cb?: () => void): void;
  destroy(): void;
}

export type BonjourFactory = () => BonjourLike;

export interface AdvertiserOptions {
  instanceName: string;
  port: number;
  txt: TxtRecord;
  factory: BonjourFactory;
}

export class MdnsAdvertiser {
  private bonjour: BonjourLike | undefined;
  private published = false;

  constructor(private readonly opts: AdvertiserOptions) {}

  get instanceName(): string {
    return this.opts.instanceName;
  }

  get advertising(): boolean {
    return this.published;
  }

  /** Register the service. Safe to call once. */
  start(): void {
    if (this.bonjour) return;
    const bonjour = this.opts.factory();
    this.bonjour = bonjour;
    bonjour.publish({
      name: this.opts.instanceName,
      type: QWEN_RC_SERVICE_TYPE,
      port: this.opts.port,
      txt: { ...this.opts.txt },
    });
    this.published = true;
  }

  /**
   * Withdraw the advertisement (Goodbye), then destroy the socket. Resolves when
   * `unpublishAll` calls back OR after `timeoutMs`, whichever is first. Idempotent
   * and a no-op when never started.
   */
  async stop(timeoutMs = 500): Promise<void> {
    const bonjour = this.bonjour;
    if (!bonjour) return;
    this.bonjour = undefined;
    this.published = false;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          bonjour.destroy();
        } catch {
          // best-effort teardown
        }
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      try {
        bonjour.unpublishAll(() => {
          clearTimeout(timer);
          finish();
        });
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  }
}
