/**
 * PlanTokenRegistry — short-lived opaque tokens for plan approval buttons.
 *
 * Telegram's `callback_data` is capped at 64 bytes, which is too small to
 * round-trip an absolute plan path. We issue an 8-char random token per
 * plan submission, hand it out inside button IDs like `plan:accept:<token>`,
 * and look up the real `{bindingId, sessionId, planPath}` when the callback
 * fires.
 *
 * Tokens expire after `ttlMs` (default 30 min) — stale buttons resolve to
 * `null` and the gateway replies "plan expired, retry from the desktop app."
 *
 * Revocation is keyed by `bindingId`, not `sessionId`. A session with two
 * Telegram bindings gets two *independent* live tokens — one per chat —
 * and issuing a new plan on one binding only invalidates that binding's
 * previous token. The old session-scoped revocation silently invalidated
 * every other binding's buttons the moment any binding rendered a new plan.
 */

import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 30 * 60 * 1000

export interface PlanTokenEntry {
  bindingId: string
  sessionId: string
  planPath: string
  messageId?: string
  createdAt: number
}

export class PlanTokenRegistry {
  private readonly tokens = new Map<string, PlanTokenEntry>()
  private readonly ttlMs: number

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  issue(
    bindingId: string,
    sessionId: string,
    planPath: string,
    messageId?: string,
  ): string {
    // Only this binding's prior plan is superseded. A sibling binding on
    // the same session keeps its live token.
    this.revokeForBinding(bindingId)
    const token = randomBytes(6).toString('base64url').slice(0, 8)
    this.tokens.set(token, {
      bindingId,
      sessionId,
      planPath,
      messageId,
      createdAt: Date.now(),
    })
    return token
  }

  resolve(token: string): PlanTokenEntry | null {
    const entry = this.tokens.get(token)
    if (!entry) return null
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.tokens.delete(token)
      return null
    }
    return entry
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }

  revokeForBinding(bindingId: string): void {
    for (const [token, entry] of this.tokens) {
      if (entry.bindingId === bindingId) this.tokens.delete(token)
    }
  }

  size(): number {
    return this.tokens.size
  }
}
