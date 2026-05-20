/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { setMaxListeners } from 'node:events';

/**
 * Default per-signal listener cap. Sized generously so OpenAI SDK retries +
 * internal stream/fetch wrappers + per-tool listeners can coexist on a single
 * short-lived per-request signal without warning.
 */
const DEFAULT_MAX_LISTENERS = 50;

/**
 * Create an AbortController with its signal pre-configured to allow a sane
 * number of listeners. Use this in place of `new AbortController()` everywhere
 * in production code.
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController();
  setMaxListeners(maxListeners, controller.signal);
  return controller;
}

function asSignal(
  parent: AbortController | AbortSignal | undefined,
): AbortSignal | undefined {
  if (!parent) return undefined;
  return parent instanceof AbortController ? parent.signal : parent;
}

/**
 * Propagate abort from a weakly-referenced parent to a weakly-referenced child.
 * Module-scope (not a per-call closure) to keep allocation cheap.
 */
function propagateAbort(
  this: WeakRef<AbortSignal>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref();
  weakChild.deref()?.abort(parent?.reason);
}

/**
 * Remove an abort handler from a weakly-referenced parent signal.
 * No-op if either side has been GC'd or the parent already fired (`{once:true}`).
 */
function removeAbortHandler(
  this: WeakRef<AbortSignal>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref();
  const handler = weakHandler.deref();
  if (parent && handler) {
    parent.removeEventListener('abort', handler);
  }
}

/**
 * Create a child AbortController that aborts when its parent aborts.
 * Aborting the child does NOT abort the parent.
 *
 * Three invariants make this safe under long-running parents with many
 * short-lived children:
 *  - The parent's abort listener is registered with `{once: true}` so it
 *    removes itself when the parent fires.
 *  - When the child aborts (from any source — parent propagation, manual
 *    abort, etc.), the listener it registered on the parent is actively
 *    removed. This is the key to preventing dead-listener accumulation on
 *    long-lived parents.
 *  - Both parent and child are held via `WeakRef`, so the parent does not
 *    strongly retain abandoned children; a child that is dropped without
 *    being aborted can still be GC'd.
 *
 * Caveat: if the parent controller is held ONLY through the child's WeakRef,
 * it can be GC'd before its `abort` fires. In practice every parent in this
 * codebase is held strongly by a long-lived owner (e.g. `this.master...`)
 * that outlives the child, so this is safe.
 *
 * Accepts an `AbortController`, an `AbortSignal`, or `undefined`. Undefined
 * returns a fresh controller with no parent propagation.
 */
export function createChildAbortController(
  parent: AbortController | AbortSignal | undefined,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners);
  const parentSignal = asSignal(parent);

  if (!parentSignal) return child;

  // Fast path: parent already aborted, no listener setup needed.
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason);
    return child;
  }

  const weakChild = new WeakRef(child);
  const weakParent = new WeakRef(parentSignal);
  const handler = propagateAbort.bind(weakParent, weakChild);

  parentSignal.addEventListener('abort', handler, { once: true });

  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  );

  return child;
}

/**
 * Combine N input signals (any undefined entries are ignored) plus an optional
 * timeout into a single child AbortSignal. The returned `cleanup` releases all
 * listeners and clears the timeout — call it on the success path so listeners
 * don't linger on long-lived input signals. Cleanup is idempotent and is also
 * invoked automatically when the returned signal aborts.
 */
export function combineAbortSignals(
  signals: ReadonlyArray<AbortSignal | undefined>,
  options?: { timeoutMs?: number; maxListeners?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const controller = createAbortController(options?.maxListeners);

  const alreadyAborted = signals.find((s) => s?.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }

  const cleanups: Array<() => void> = [];

  for (const sourceSignal of signals) {
    if (!sourceSignal) continue;
    const handler = () => controller.abort(sourceSignal.reason);
    sourceSignal.addEventListener('abort', handler, { once: true });
    cleanups.push(() => sourceSignal.removeEventListener('abort', handler));
  }

  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException('Operation timed out', 'TimeoutError'));
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timeoutId));
  }

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    for (const fn of cleanups) fn();
  };

  controller.signal.addEventListener('abort', cleanup, { once: true });

  return { signal: controller.signal, cleanup };
}
