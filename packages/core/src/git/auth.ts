/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitAuth } from './types.js';

export class GitAuthManager {
  private static tokens = new Map<string, string>();

  /**
   * Set a token for a specific provider (e.g. 'github', 'gitlab').
   */
  static setToken(provider: string, token: string): void {
    this.tokens.set(provider.toLowerCase(), token);
  }

  /**
   * Returns a token for a given provider, checking the local map first
   * and then environment variables (e.g., GITHUB_TOKEN).
   */
  static getToken(provider: string): string | undefined {
    const p = provider.toLowerCase();
    const token = this.tokens.get(p);
    if (token) {
      return token;
    }

    // Check environment variables
    const envKey = `${p.toUpperCase()}_TOKEN`;
    return process.env[envKey];
  }

  /**
   * Resolve auth for a given provider.
   */
  static resolveAuth(provider: string): GitAuth {
    const token = this.getToken(provider);
    return { token };
  }
}
