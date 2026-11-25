/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A server inventing cursors forever is cut off rather than looping. */
const MAX_PAGES = 100;

/**
 * Guards a catalog cursor loop: a cursor seen before means the server is not
 * advancing, and an endless supply of new ones is bounded by a page count.
 * Throws a normal Error; the discovery caller decides how to report it.
 */
export class McpCursorPager {
  private readonly seen = new Set<string>();
  private pages = 0;

  next(cursor: string | undefined, catalog: string): void {
    if (cursor === undefined) return;
    if (this.seen.has(cursor)) {
      throw new Error(
        `MCP ${catalog} pagination returned the same cursor twice; stopping`,
      );
    }
    this.seen.add(cursor);
    this.pages += 1;
    if (this.pages > MAX_PAGES) {
      throw new Error(
        `MCP ${catalog} pagination exceeded ${MAX_PAGES} pages; stopping`,
      );
    }
  }
}
