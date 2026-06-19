/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orchestrates a domain's ACME cert lifecycle: load from the {@link CertBundleStore},
 * obtain via the {@link AcmeClient} (DNS-01) when absent or due, persist, and keep
 * a renewal loop running. Exposes the current bundle for the https server and an
 * `onChange` hook so a live cert swap (Slice 4 SNICallback) takes effect with no
 * restart.
 *
 * **Renewal scheduling — the load-bearing detail.** Node's `setTimeout` delay is a
 * 32-bit int (~24.8 days max); a larger delay silently clamps to ~1ms and fires
 * almost immediately. A fresh 90-day cert renews in ~60 days ≈ 5.2e9 ms — 2.4× the
 * cap — so arming one long timer would RE-ISSUE on every boot and trip Let's
 * Encrypt's duplicate-cert limit (a week-long lockout). Instead we **cap each sleep
 * at `maxTimerMs` (default 6h) and re-check on wake** — a poll loop, never one
 * multi-week timer.
 *
 * **Fail-safe.** A renewal failure with a still-valid current cert is non-fatal:
 * keep serving it, log, retry with capped backoff (LE has a failed-validation
 * limit too). Only a boot with NO usable cert (absent + obtain fails) is fatal.
 */
import {
  shouldRenew,
  msUntilRenewal,
  DEFAULT_RENEW_BEFORE_DAYS,
} from './renewalSchedule.js';
import type { CertBundle } from './certStore.js';
import type { DnsProvider } from './dnsProvider.js';

export interface AcmeIssuedCert {
  /** Leaf certificate, PEM. */
  cert: string;
  /** Issuer chain, PEM. */
  chain: string;
  /** Private key for the leaf, PEM. */
  privateKey: string;
  /** Parsed expiry (drives renewal). */
  notAfter: Date;
}

/** The ACME issuance surface the manager drives (real impl wraps `acme-client`). */
export interface AcmeClient {
  obtainCertificate(
    req: {
      domains: string[];
      email: string;
      directoryUrl: string;
      accountKeyPem: string;
    },
    provider: DnsProvider,
  ): Promise<AcmeIssuedCert>;
}

/** Minimal persistence surface (the concrete `CertStore` satisfies it). */
export interface CertBundleStore {
  load(primaryDomain: string): Promise<CertBundle | null>;
  save(primaryDomain: string, bundle: CertBundle): Promise<void>;
}

export interface AcmeManagerOptions {
  domains: string[];
  email: string;
  directoryUrl: string;
  provider: DnsProvider;
  client: AcmeClient;
  store: CertBundleStore;
  /** Load-or-create the ACME account key (PEM). Called once, then cached. */
  accountKey: () => Promise<string>;
  renewBeforeDays?: number;
  /** Per-sleep cap (default 6h). MUST stay under setTimeout's 2^31-1 ms limit. */
  maxTimerMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
  onChange?: (bundle: CertBundle) => void;
}

const DEFAULT_MAX_TIMER_MS = 6 * 60 * 60 * 1000; // 6h ≪ 2_147_483_647
const DEFAULT_BASE_BACKOFF_MS = 5 * 60 * 1000; // 5m
const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h

export class AcmeManager {
  private current: CertBundle | null = null;
  private accountKeyPem: string | null = null;
  private timer: unknown = null;
  private stopped = false;
  private backoffMs: number;

  constructor(private readonly opts: AcmeManagerOptions) {
    this.backoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  }

  /** The current cert bundle (null before {@link start}). */
  getCurrent(): CertBundle | null {
    return this.current;
  }

  /** Acquire-or-load the cert, then arm the renewal loop. Returns the live bundle. */
  async start(): Promise<CertBundle> {
    const stored = await this.opts.store.load(this.opts.domains[0]);
    if (stored && !this.isDue(stored)) {
      this.current = stored;
    } else {
      try {
        await this.obtain();
      } catch (err) {
        const msg = errMsg(err);
        if (stored) {
          this.log(
            `acme: initial renewal failed; serving the stored cert ` +
              `(notAfter=${stored.meta.notAfter}) — ${msg}`,
          );
          this.current = stored;
        } else {
          throw new Error(
            `acme: could not obtain an initial certificate for ` +
              `${this.opts.domains[0]}: ${msg}`,
          );
        }
      }
    }
    this.scheduleNext();
    return this.current as CertBundle;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      (this.opts.clearTimer ?? clearTimeout)(this.timer as never);
      this.timer = null;
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private maxTimer(): number {
    return this.opts.maxTimerMs ?? DEFAULT_MAX_TIMER_MS;
  }
  private renewDays(): number {
    return this.opts.renewBeforeDays ?? DEFAULT_RENEW_BEFORE_DAYS;
  }
  private log(m: string): void {
    this.opts.log?.(m);
  }
  private isDue(bundle: CertBundle): boolean {
    return shouldRenew(
      new Date(bundle.meta.notAfter),
      new Date(this.now()),
      this.renewDays(),
    );
  }

  private async resolveAccountKey(): Promise<string> {
    if (this.accountKeyPem == null) {
      this.accountKeyPem = await this.opts.accountKey();
    }
    return this.accountKeyPem;
  }

  private async obtain(): Promise<void> {
    const accountKeyPem = await this.resolveAccountKey();
    const issued = await this.opts.client.obtainCertificate(
      {
        domains: this.opts.domains,
        email: this.opts.email,
        directoryUrl: this.opts.directoryUrl,
        accountKeyPem,
      },
      this.opts.provider,
    );
    const bundle: CertBundle = {
      cert: issued.cert,
      chain: issued.chain,
      privateKey: issued.privateKey,
      meta: {
        domains: this.opts.domains,
        notAfter: issued.notAfter.toISOString(),
        issuedAt: new Date(this.now()).toISOString(),
      },
    };
    await this.opts.store.save(this.opts.domains[0], bundle);
    this.current = bundle;
    this.opts.onChange?.(bundle);
  }

  /** Arm the next wake — capped at `maxTimerMs` so a multi-week delay never clamps. */
  private scheduleNext(retryAfterMs?: number): void {
    if (this.stopped || !this.current) return;
    const due = msUntilRenewal(
      new Date(this.current.meta.notAfter),
      new Date(this.now()),
      this.renewDays(),
    );
    const delay = Math.max(0, Math.min(retryAfterMs ?? due, this.maxTimer()));
    this.timer = (this.opts.setTimer ?? setTimeout)(() => this.onWake(), delay);
  }

  private async onWake(): Promise<void> {
    if (this.stopped || !this.current) return;
    if (!this.isDue(this.current)) {
      this.scheduleNext();
      return;
    }
    try {
      await this.obtain();
      this.backoffMs = this.opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
      this.scheduleNext();
    } catch (err) {
      this.log(
        `acme: renewal failed, keeping current cert ` +
          `(notAfter=${this.current.meta.notAfter}); retrying — ${errMsg(err)}`,
      );
      const retry = this.backoffMs;
      this.backoffMs = Math.min(
        this.backoffMs * 2,
        this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      );
      this.scheduleNext(retry);
    }
  }
}

function errMsg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}
