/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks active stream abort controllers per token id so a token revocation
 * can immediately tear down that token's live connections.
 */
export class ConnectionRegistry {
  private byToken = new Map<string, Set<AbortController>>();

  /** Register a controller for a token id; returns an idempotent unregister. */
  register(tokenId: string, ctrl: AbortController): () => void {
    let set = this.byToken.get(tokenId);
    if (!set) {
      set = new Set();
      this.byToken.set(tokenId, set);
    }
    set.add(ctrl);
    return () => {
      const s = this.byToken.get(tokenId);
      if (!s) return;
      s.delete(ctrl);
      if (s.size === 0) this.byToken.delete(tokenId);
    };
  }

  /** Abort every controller registered under a token id, then forget them. */
  evict(tokenId: string): void {
    const set = this.byToken.get(tokenId);
    if (!set) return;
    for (const ctrl of set) ctrl.abort();
    this.byToken.delete(tokenId);
  }
}
