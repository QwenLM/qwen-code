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
 * `MaxListenersExceededWarning` for AbortSignal / EventTarget while letting
 * every other warning through. In debug mode (NODE_ENV=development, or
 * DEBUG / QWEN_DEBUG set), all warnings are forwarded to stderr so
 * developers can still see them.
 *
 * Idempotent — repeated calls are a no-op.
 */
export function initializeWarningHandler(): void {
  if (installedHandler) return;

  const debug = isDebugMode();

  installedHandler = (warning: Error) => {
    if (!debug && isSuppressed(warning)) return;
    const text = warning.stack ?? `${warning.name}: ${warning.message}`;
    process.stderr.write(`(node) ${text}\n`);
  };

  // Adding a listener (instead of removeAllListeners) leaves any third-party
  // warning subscribers in place. Node's default printer only fires when
  // there are zero listeners — so installing our handler implicitly disables
  // the default print path, and we take over forwarding to stderr for the
  // non-suppressed cases.
  process.on('warning', installedHandler);
}
