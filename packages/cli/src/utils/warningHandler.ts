/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Warnings we know about and want to keep out of the user-facing terminal.
 * Listener accumulation on long-lived AbortSignals during multi-round agent
 * sessions is structural, not a real memory leak — the listeners are removed
 * (via {once:true} + reverse-cleanup in utils/abortController.ts) but a few
 * extreme cases (e.g. OpenAI retry storms layered with multiple wrappers) can
 * still graze the per-signal cap. Match any MaxListenersExceededWarning that
 * mentions AbortSignal so we cover every shape Node ≥20 emits — `[AbortSignal]`,
 * `[AbortSignal{...}]`, `[AbortSignal { ... }]`. We deliberately don't match
 * the generic `EventTarget` token so unrelated EventTarget leaks stay visible.
 */
const SUPPRESSED_WARNINGS: RegExp[] = [
  /MaxListenersExceededWarning.*AbortSignal/,
];

function isSuppressed(warning: Error): boolean {
  const text = `${warning.name}: ${warning.message}`;
  return SUPPRESSED_WARNINGS.some((re) => re.test(text));
}

function isDebugMode(): boolean {
  if (process.env['NODE_ENV'] === 'development') return true;
  const truthy = (v: string | undefined) =>
    !!v && v !== '0' && v.toLowerCase() !== 'false';
  return truthy(process.env['DEBUG']) || truthy(process.env['QWEN_DEBUG']);
}

let installedHandler: ((warning: Error) => void) | null = null;

/**
 * For tests only — uninstall the handler and reset internal state.
 */
export function resetWarningHandlerForTests(): void {
  if (installedHandler) {
    process.removeListener('warning', installedHandler);
    installedHandler = null;
  }
}

/**
 * Install a process-level `warning` handler that swallows the well-known
 * `MaxListenersExceededWarning` for AbortSignal while letting every other
 * warning through — including generic EventTarget leak warnings, which we
 * leave visible because they likely indicate a real leak elsewhere. In
 * debug mode (NODE_ENV=development, or DEBUG / QWEN_DEBUG set), all
 * warnings are forwarded so developers can still see them.
 *
 * Implementation note: simply adding a `warning` listener does NOT prevent
 * Node's default printer from writing to stderr — the default handler is
 * registered as an ordinary listener (`lib/internal/process/warning.js`).
 * To actually suppress targeted warnings, we capture the existing listeners
 * (which include the default printer and any third-party telemetry hooks),
 * remove them, then install ours as the sole listener. Non-suppressed
 * warnings get fanned out to the captured listeners so the default printer
 * still fires for them; suppressed warnings stop here.
 *
 * Idempotent — repeated calls are a no-op.
 */
export function initializeWarningHandler(): void {
  if (installedHandler) return;

  // Snapshot everything currently listening on 'warning' (Node's default
  // onWarning printer + any third-party telemetry subscribers). We will fan
  // out non-suppressed warnings back to them.
  //
  // Trade-offs to be aware of (documented for future readers):
  //  - Listeners ADDED via `process.on('warning', ...)` after this init are
  //    independent of our snapshot. They receive `process.emit('warning')`
  //    directly and bypass the suppression filter. Node's default printer
  //    is in our snapshot (not added later), so stderr stays clean; late
  //    telemetry will see the full warning stream including AbortSignal
  //    leaks. This is intentional — telemetry should see what's happening.
  //  - Listeners REMOVED via `process.removeListener('warning', fn)` after
  //    this init have no effect: we hold our own strong reference in the
  //    snapshot. Re-snapshotting per warning doesn't fix this because the
  //    listeners are already removed from Node's list (we called
  //    `process.removeAllListeners` to disable Node's default printing of
  //    suppressed warnings). Callers who need conditional fan-out should
  //    install BEFORE initializeWarningHandler.
  const priorListeners = [...process.listeners('warning')] as Array<
    (warning: Error) => void
  >;

  installedHandler = (warning: Error) => {
    // Evaluate isDebugMode() per warning so DEBUG / QWEN_DEBUG can be
    // toggled at runtime (e.g. via a `/debug` slash command) without
    // re-running initializeWarningHandler.
    if (!isDebugMode() && isSuppressed(warning)) return;
    for (const fn of priorListeners) {
      try {
        fn(warning);
      } catch {
        // Don't let a misbehaving prior listener (e.g. a buggy telemetry
        // hook) take down warning delivery for the rest of the chain.
      }
    }
  };

  process.removeAllListeners('warning');
  process.on('warning', installedHandler);
}
