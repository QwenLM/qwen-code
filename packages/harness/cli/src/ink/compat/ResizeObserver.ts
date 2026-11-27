/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import type { DOMElement } from '../dom.js';

export type ResizeObserverCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

/**
 * An entry describing a single observed element's new size, mirroring the
 * shape used by GMN's ink `ResizeObserverEntry`.
 */
export class ResizeObserverEntry {
  readonly target: DOMElement;
  readonly contentRect: { width: number; height: number };

  constructor(
    target: DOMElement,
    contentRect: { width: number; height: number },
  ) {
    this.target = target;
    this.contentRect = contentRect;
  }
}

// Global registry of all active ResizeObserver instances.
// triggerResizeObservers() iterates this set after yoga layout to fire callbacks.
const activeObservers = new Set<ResizeObserver>();

// ---- Deferred notification queue ----
// Callbacks are NOT fired synchronously inside resetAfterCommit (React's commit
// phase).  Instead we collect size-change entries during a synchronous
// yoga-measurement pass and flush the actual callbacks via queueMicrotask.
//
// This breaks the infinite loop:
//   commit → yoga → ResizeObserver.setState → commit → yoga → …
// that caused "Maximum update depth exceeded" in dev mode.
let pendingNotifications: Array<{
  observer: ResizeObserver;
  entries: ResizeObserverEntry[];
}> = [];
let microtaskScheduled = false;

function flushPendingNotifications(): void {
  microtaskScheduled = false;
  const batch = pendingNotifications;
  pendingNotifications = [];
  for (const { observer, entries } of batch) {
    // Guard: observer may have been disconnected between collect and flush.
    if (activeObservers.has(observer)) {
      observer._fireCallback(entries);
    }
  }
}

/**
 * Run any collected notifications now instead of on the microtask queue.
 *
 * Layout moved from commit time to frame time. The microtask that normally
 * delivers these callbacks used to run before the frame was painted; after the
 * move it would run after, leaving observers like Scrollable a frame behind.
 * Ink's per-frame settle loop calls this so they keep their pre-paint timing,
 * and the loop's pass cap still bounds the commit→layout→setState recursion the
 * deferral was introduced to break.
 */
export function flushResizeObserversSync(): void {
  if (pendingNotifications.length === 0) return;
  flushPendingNotifications();
}

/**
 * Walk all active ResizeObserver instances, compare each observed element's
 * current yoga-computed size against the last-reported size, and **defer**
 * callbacks to a microtask so setState calls don't re-enter React's commit
 * phase.
 *
 * Call this after yoga layout is computed (e.g. after calculateLayout()).
 */
export function triggerResizeObservers(): void {
  for (const observer of activeObservers) {
    observer._collectChanges();
  }
  if (pendingNotifications.length > 0 && !microtaskScheduled) {
    microtaskScheduled = true;
    queueMicrotask(flushPendingNotifications);
  }
}

/**
 * Compat shim for GMN ink's `ResizeObserver` class.
 *
 * Mirrors the browser ResizeObserver API, observing `DOMElement` nodes and
 * calling back with `ResizeObserverEntry[]` whenever a node's yoga-computed
 * layout size changes. Triggering is done by `triggerResizeObservers()`,
 * called from the ink render pipeline after yoga layout.
 */
export default class ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private readonly observedElements: Set<DOMElement>;
  // Track last-reported sizes to detect changes
  private readonly lastSizes: Map<
    DOMElement,
    { width: number; height: number }
  >;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    this.observedElements = new Set();
    this.lastSizes = new Map();
    activeObservers.add(this);
  }

  observe(element: DOMElement): void {
    this.observedElements.add(element);
  }

  unobserve(element: DOMElement): void {
    this.observedElements.delete(element);
    this.lastSizes.delete(element);
  }

  disconnect(): void {
    this.observedElements.clear();
    this.lastSizes.clear();
    activeObservers.delete(this);
  }

  /**
   * Called internally by the render pipeline to notify this observer of
   * layout changes. Not part of the public API but mirrors the GMN ink
   * internal method so the renderer can call it when ready.
   */
  internalTrigger(entries: ResizeObserverEntry[]): void {
    if (entries.length > 0) {
      this.callback(entries, this);
    }
  }

  /**
   * Fire the observer callback directly.  Used by the deferred flush.
   */
  _fireCallback(entries: ResizeObserverEntry[]): void {
    if (entries.length > 0) {
      this.callback(entries, this);
    }
  }

  /**
   * Synchronously read yoga-computed sizes for all observed elements, compare
   * against cached values, and queue any changes into `pendingNotifications`.
   * The actual callback is fired later by `flushPendingNotifications()`.
   *
   * Called by triggerResizeObservers() from the render pipeline.
   */
  _collectChanges(): void {
    const entries: ResizeObserverEntry[] = [];

    for (const element of this.observedElements) {
      const yogaNode = element.yogaNode;
      if (!yogaNode) continue;

      const width = Math.round(yogaNode.getComputedWidth());
      const height = Math.round(yogaNode.getComputedHeight());

      // Check for valid dimensions
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;

      const last = this.lastSizes.get(element);
      if (!last || last.width !== width || last.height !== height) {
        this.lastSizes.set(element, { width, height });
        entries.push(new ResizeObserverEntry(element, { width, height }));
      }
    }

    if (entries.length > 0) {
      pendingNotifications.push({ observer: this, entries });
    }
  }
}
