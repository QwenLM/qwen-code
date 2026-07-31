/**
 * Tests for PairingCodeManager consume-side rate limiting.
 *
 * The existing test file covers issuance. These tests cover the new
 * `canConsume` budget that protects against brute-forcing 6-digit codes
 * via /pair. Counting on entry (not after validation) is important —
 * otherwise wrong guesses would cost nothing.
 */
import { describe, it, expect } from 'bun:test'
import { PairingCodeManager, PAIR_CONSUME_RATE_PER_MINUTE } from './pairing'

describe('PairingCodeManager.canConsume', () => {
  it('allows up to PAIR_CONSUME_RATE_PER_MINUTE attempts per minute per sender', () => {
    const mgr = new PairingCodeManager()
    const ws = 'ws-1'
    const platform = 'telegram' as const
    const sender = '12345'

    for (let i = 0; i < PAIR_CONSUME_RATE_PER_MINUTE; i++) {
      expect(mgr.canConsume(ws, platform, sender)).toBe(true)
    }
    expect(mgr.canConsume(ws, platform, sender)).toBe(false)
  })

  it('counts right AND wrong attempts alike (attempt-based, not failure-based)', () => {
    // Use a short-TTL manager with a generate rate high enough for this test.
    const mgr = new PairingCodeManager()
    const sender = 'sender-a'
    const { code } = mgr.generate('ws-1', 'sess-1', 'telegram')

    // Two wrong attempts…
    expect(mgr.canConsume('ws-1', 'telegram', sender)).toBe(true)
    expect(mgr.canConsume('ws-1', 'telegram', sender)).toBe(true)
    // …then one correct consume. That's 3 of 5.
    expect(mgr.canConsume('ws-1', 'telegram', sender)).toBe(true)
    expect(mgr.consume('ws-1', 'telegram', code)).not.toBeNull()

    // 2 more attempts allowed, then blocked.
    expect(mgr.canConsume('ws-1', 'telegram', sender)).toBe(true)
    expect(mgr.canConsume('ws-1', 'telegram', sender)).toBe(true)
    expect(mgr.canConsume('ws-1', 'telegram', sender)).toBe(false)
  })

  it('scopes buckets by (workspace, platform, sender) so they do not bleed', () => {
    const mgr = new PairingCodeManager()

    // Exhaust one sender's budget.
    for (let i = 0; i < PAIR_CONSUME_RATE_PER_MINUTE; i++) {
      mgr.canConsume('ws-1', 'telegram', 'sender-a')
    }
    expect(mgr.canConsume('ws-1', 'telegram', 'sender-a')).toBe(false)

    // Different sender, same workspace+platform → independent bucket.
    expect(mgr.canConsume('ws-1', 'telegram', 'sender-b')).toBe(true)
    // Different platform, same workspace+sender → independent bucket.
    expect(mgr.canConsume('ws-1', 'whatsapp', 'sender-a')).toBe(true)
    // Different workspace → independent bucket.
    expect(mgr.canConsume('ws-2', 'telegram', 'sender-a')).toBe(true)
  })

  it('resets the bucket after the 60-second window', () => {
    // Small custom rate so we can exhaust it quickly; window is fixed at 60s.
    const mgr = new PairingCodeManager(undefined, undefined, 2)

    expect(mgr.canConsume('ws-1', 'telegram', 's')).toBe(true)
    expect(mgr.canConsume('ws-1', 'telegram', 's')).toBe(true)
    expect(mgr.canConsume('ws-1', 'telegram', 's')).toBe(false)

    // Rewind the bucket's windowStart past the 60s cutoff.
    // Internal access is ugly but cheaper than a fake-clock scaffold.
    const buckets = (mgr as unknown as { consumeBuckets: Map<string, { windowStart: number; count: number }> }).consumeBuckets
    const bucket = buckets.get('ws-1:telegram:s')
    expect(bucket).toBeDefined()
    if (bucket) bucket.windowStart = Date.now() - 61_000

    expect(mgr.canConsume('ws-1', 'telegram', 's')).toBe(true)
  })
})
