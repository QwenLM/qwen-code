/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Policy } from './loader.js';

/** Injected timer surface (defaults to the global timers; faked in tests). */
type Schedule = (fn: () => void, ms: number) => unknown;
type Cancel = (handle: unknown) => void;

export interface PolicyReloaderOptions {
  /** Re-read the (layered) policy. May reject (malformed file). */
  load: () => Promise<Policy>;
  /**
   * Apply a freshly-loaded policy. MUST be synchronous so a reload is atomic
   * relative to an in-flight `handlePermission` await-boundary (the enforcer's
   * `setPolicy` assignment + the quota `limitsFor` map mutation are both sync,
   * so a reload landing mid-handler can't tear state — the handler already
   * captured its decision from the old policy and only re-checks
   * `remaining(ruleId)` against the new limits, which is fail-safe).
   */
  apply: (policy: Policy) => void;
  /** Called after a successful apply (e.g. audit `policy_reloaded`). */
  onReloaded: (policy: Policy) => void;
  /** Called when a reload FAILS (old policy retained); e.g. audit the error. */
  onError: (err: unknown) => void;
  /** Debounce window in ms (default 250 — spec D4). */
  debounceMs?: number;
  schedule?: Schedule;
  cancel?: Cancel;
}

/**
 * Debounced policy hot-reloader. `trigger()` (called by a filesystem watcher)
 * coalesces rapid edits into a single reload `debounceMs` later. A reload that
 * throws/rejects RETAINS the previous policy (apply is never called) and reports
 * via `onError` — a running gateway must never crash or widen because the
 * operator saved a half-typed edit (design.md:74; spec "Parse error preserves
 * previous ruleset"). Every method is total (never throws to the caller).
 */
export class PolicyReloader {
  private readonly load: () => Promise<Policy>;
  private readonly apply: (policy: Policy) => void;
  private readonly onReloaded: (policy: Policy) => void;
  private readonly onError: (err: unknown) => void;
  private readonly debounceMs: number;
  private readonly schedule: Schedule;
  private readonly cancel: Cancel;

  private timer: unknown = undefined;
  private running = false;
  /** A trigger arrived while a reload was in flight → run exactly once more. */
  private pending = false;

  constructor(opts: PolicyReloaderOptions) {
    this.load = opts.load;
    this.apply = opts.apply;
    this.onReloaded = opts.onReloaded;
    this.onError = opts.onError;
    this.debounceMs = opts.debounceMs ?? 250;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Note a filesystem change; (re)arm the debounce timer. */
  trigger(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.run();
    }, this.debounceMs);
  }

  /** Cancel any pending reload (shutdown). */
  stop(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  private async run(): Promise<void> {
    // Coalesce a trigger that lands while a reload is already awaiting load():
    // remember it and re-run exactly once after this pass, so the last edit wins
    // without overlapping reloads.
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      const policy = await this.load();
      try {
        this.apply(policy);
        this.onReloaded(policy);
      } catch (err) {
        // apply/onReloaded should be total; guard anyway so the reloader stays
        // total even if a callback throws.
        this.onError(err);
      }
    } catch (err) {
      // load() rejected (malformed/unreadable) → retain the previous policy.
      this.onError(err);
    } finally {
      this.running = false;
    }
    if (this.pending) {
      this.pending = false;
      await this.run();
    }
  }
}
