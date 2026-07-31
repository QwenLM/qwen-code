/**
 * PairingCodeManager tests
 *
 * Covers:
 *   - generate() returns 6-digit code and future expiry
 *   - consume() atomicity (single-use) and workspace-scoping
 *   - expired codes return null without counting as success
 *   - rate limit enforces per-minute cap with RATE_LIMIT error code
 *   - clearWorkspace() scopes only to the given workspace
 */
import { describe, expect, it } from 'bun:test'
import { PairingCodeManager } from '../pairing'

describe('PairingCodeManager', () => {
  it('generates a 6-digit numeric code with future expiry', () => {
    const mgr = new PairingCodeManager()
    const { code, expiresAt } = mgr.generate('ws1', 'sess', 'telegram')
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBeGreaterThan(Date.now())
  })

  it('consumes a code exactly once', () => {
    const mgr = new PairingCodeManager()
    const { code } = mgr.generate('ws1', 'sess', 'telegram')

    const first = mgr.consume('ws1', 'telegram', code)
    expect(first?.sessionId).toBe('sess')

    const second = mgr.consume('ws1', 'telegram', code)
    expect(second).toBeNull()
  })

  it('rejects consumption by a different workspace', () => {
    const mgr = new PairingCodeManager()
    const { code } = mgr.generate('ws1', 'sess', 'telegram')
    expect(mgr.consume('ws2', 'telegram', code)).toBeNull()
    // Still redeemable by correct ws
    expect(mgr.consume('ws1', 'telegram', code)?.sessionId).toBe('sess')
  })

  it('returns null for expired codes', () => {
    const mgr = new PairingCodeManager(1) // 1ms TTL
    const { code } = mgr.generate('ws1', 'sess', 'telegram')
    // Busy-wait a hair past TTL
    const until = Date.now() + 5
    while (Date.now() < until) {
      // spin
    }
    expect(mgr.consume('ws1', 'telegram', code)).toBeNull()
  })

  it('scopes codes per platform', () => {
    const mgr = new PairingCodeManager()
    const { code } = mgr.generate('ws1', 'sess', 'telegram')
    expect(mgr.consume('ws1', 'whatsapp', code)).toBeNull()
  })

  it('throws RATE_LIMIT after the per-minute cap', () => {
    const mgr = new PairingCodeManager(60_000, 3)
    mgr.generate('ws1', 'sess', 'telegram')
    mgr.generate('ws1', 'sess', 'telegram')
    mgr.generate('ws1', 'sess', 'telegram')

    let caught: unknown
    try {
      mgr.generate('ws1', 'sess', 'telegram')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error & { code?: string }).code).toBe('RATE_LIMIT')
  })

  it('rate-limits per workspace, not globally', () => {
    const mgr = new PairingCodeManager(60_000, 2)
    mgr.generate('ws1', 'sess', 'telegram')
    mgr.generate('ws1', 'sess', 'telegram')
    // ws2 still has full budget
    expect(() => mgr.generate('ws2', 'sess', 'telegram')).not.toThrow()
  })

  it('clearWorkspace removes only codes for that workspace', () => {
    const mgr = new PairingCodeManager()
    const a = mgr.generate('ws1', 'sA', 'telegram')
    const b = mgr.generate('ws2', 'sB', 'telegram')

    mgr.clearWorkspace('ws1')
    expect(mgr.consume('ws1', 'telegram', a.code)).toBeNull()
    expect(mgr.consume('ws2', 'telegram', b.code)?.sessionId).toBe('sB')
  })
})
