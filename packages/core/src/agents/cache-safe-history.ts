/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How many trailing curated history entries the cache-safe snapshot keeps.
 * A forked agent — the managed auto-memory extractor among them — sees only
 * this tail of the conversation, not all of it.
 *
 * Kept in a module with no imports so the memory manager can derive its own
 * bound from it at load time without joining the forkedAgent → config cycle.
 */
export const CACHE_SAFE_HISTORY_TAIL_ENTRIES = 40;
