/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Injected timer surface (defaults to the global timers; faked in tests). */
type Schedule = (fn: () => void, ms: number) => unknown;
type Cancel = (handle: unknown) => void;

export interface DebouncedReloaderOptions<T> {
  /** Re-read the resource. May reject (malformed file) → previous value retained. */
  load: () => Promise<T>;
  /**
   * Apply a freshly-loaded value. SHOULD be synchronous so a reload is atomic
   * relative to an in-flight consumer await-boundary (e.g. the policy enforcer's
   * `setPolicy` and the notifier's `setRouting` are both sync field swaps that a
   * reload landing mid-handler can't tear).
   */
  apply: (value: T) => void;
  /** Called after a successful apply (e.g. audit `<thing>_reloaded`). */
  onReloaded: (value: T) => void;
  /** Called when a reload FAILS (old value retained); e.g. audit the error. */
  onError: (err: unknown) => void;
  /** Debounce window in ms (default 250 — spec). */
  debounceMs?: number;
  schedule?: Schedule;
  cancel?: Cancel;
}

/**
 * Debounced hot-reloader for a single watched resource. `trigger()` (called by a
 * filesystem watcher) coalesces rapid edits into a single reload `debounceMs`
 * later. A reload that throws/rejects RETAINS the previous value (apply is never
 * called) and reports via `onError` — a running gateway must never crash or
 * widen because the operator saved a half-typed edit. Every method is total
 * (never throws to the caller).
 *
 * Generalizes the original {@link PolicyReloader} so the routing reloader (and any
 * future config) reuses the exact debounce/coalesce/retain-on-error machinery
 * rather than re-deriving its subtle in-flight semantics.
 */
export class DebouncedReloader<T> {
  private readonly load: () => Promise<T>;
  private readonly apply: (value: T) => void;
  private readonly onReloaded: (value: T) => void;
  private readonly onError: (err: unknown) => void;
  private readonly debounceMs: number;
  private readonly schedule: Schedule;
  private readonly cancel: Cancel;

  private timer: unknown = undefined;
  private running = false;
  /** A trigger arrived while a reload was in flight → run exactly once more. */
  private pending = false;

  constructor(opts: DebouncedReloaderOptions<T>) {
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
      const value = await this.load();
      try {
        this.apply(value);
        this.onReloaded(value);
      } catch (err) {
        // apply/onReloaded should be total; guard anyway so the reloader stays
        // total even if a callback throws.
        this.onError(err);
      }
    } catch (err) {
      // load() rejected (malformed/unreadable) → retain the previous value.
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
