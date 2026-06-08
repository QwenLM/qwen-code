/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import '../types.js';

/**
 * In-memory, process-local tracker of recently-active tokens ("working
 * devices"). A token is "working" if it posted within `windowMs`. State has no
 * value across restarts, so it is never persisted. `nowFn` is injectable so
 * expiry is deterministic in tests.
 */
export class WorkingDeviceTracker {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs: number = 120000,
    private readonly nowFn: () => number = Date.now,
  ) {}

  /** Record activity for `tokenId` as of now. */
  touch(tokenId: string): void {
    this.last.set(tokenId, this.nowFn());
  }

  /** True if `tokenId` posted within the window (unknown token → false). */
  isWorking(tokenId: string): boolean {
    const last = this.last.get(tokenId);
    return this.nowFn() - (last ?? -Infinity) < this.windowMs;
  }
}

/**
 * Middleware that records activity for the authenticated caller. Touches the
 * tracker only when `req.rcClient?.id` is present; never throws; always calls
 * `next()`. Mounted after `requireScope` so `req.rcClient` is set.
 */
export function recordActivity(tracker: WorkingDeviceTracker): RequestHandler {
  return (req, _res, next) => {
    const id = req.rcClient?.id;
    if (id) tracker.touch(id);
    next();
  };
}
