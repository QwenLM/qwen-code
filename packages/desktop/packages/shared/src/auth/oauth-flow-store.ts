/**
 * OAuthFlowStore — in-memory store for pending OAuth flows.
 *
 * Lives server-side. Never serialized, never sent to clients.
 * Keyed by `state` (CSRF token) for O(1) lookup on oauth:complete.
 * 5-minute TTL with lazy + periodic cleanup.
 */

import type { LoadedSource } from '../sources/types.ts';
import type { OAuthProvider } from './oauth-flow-types.ts';

const FLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every minute

export interface PendingOAuthFlow {
  flowId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  source: LoadedSource;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  provider: OAuthProvider;

  // Binding fields — validated on oauth:complete
  ownerClientId: string;
  workspaceId: string;
  sourceSlug: string;

  // Optional session binding (when initiated from auth request card)
  sessionId?: string;
  authRequestId?: string;

  createdAt: number;
  expiresAt: number;
}

export class OAuthFlowStore {
  private flows = new Map<string, PendingOAuthFlow>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  store(flow: PendingOAuthFlow): void {
    this.flows.set(flow.state, flow);
  }

  getByState(state: string): PendingOAuthFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;

    // Check expiry lazily
    if (Date.now() > flow.expiresAt) {
      this.flows.delete(state);
      return null;
    }

    return flow;
  }

  remove(state: string): void {
    this.flows.delete(state);
  }

  /** Prune expired entries. Called on interval + lazily on access. */
  cleanup(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) {
      if (now > flow.expiresAt) {
        this.flows.delete(state);
      }
    }
  }

  /** Stop the periodic cleanup timer (for graceful shutdown). */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.flows.clear();
  }

  /** Number of pending flows (for diagnostics). */
  get size(): number {
    return this.flows.size;
  }
}

/**
 * Create a PendingOAuthFlow with default TTL.
 * Convenience helper used by the oauth:start handler.
 */
export function createPendingFlow(
  params: Omit<PendingOAuthFlow, 'createdAt' | 'expiresAt'>
): PendingOAuthFlow {
  const now = Date.now();
  return {
    ...params,
    createdAt: now,
    expiresAt: now + FLOW_TTL_MS,
  };
}
