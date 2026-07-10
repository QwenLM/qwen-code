/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ConnectionRegistryOptions {
  /**
   * Called synchronously after aborting all controllers for a token id
   * (i.e. when the token is evicted). Use this to emit a `client_evicted`
   * presence event on every affected session stream.
   */
  onEvict?: (tokenId: string) => void;
}

/**
 * Tracks active stream abort controllers per token id so a token revocation
 * can immediately tear down that token's live connections.
 */
export class ConnectionRegistry {
  private byToken = new Map<string, Set<AbortController>>();
  private readonly onEvict: ((tokenId: string) => void) | undefined;

  constructor(opts: ConnectionRegistryOptions = {}) {
    this.onEvict = opts.onEvict;
  }

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
    this.onEvict?.(tokenId);
  }
}
