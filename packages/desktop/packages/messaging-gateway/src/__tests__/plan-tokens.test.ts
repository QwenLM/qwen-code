/**
 * PlanTokenRegistry — short-lived token lookup for Telegram plan approvals.
 *
 * Tokens are opaque, per-binding revocable, TTL-expiring. These tests cover
 * the happy path, expiry, re-issue semantics, and the critical multi-binding
 * isolation case — one session with two Telegram bindings must keep two
 * independent live tokens, one per chat.
 */

import { describe, expect, it } from 'bun:test'
import { PlanTokenRegistry } from '../plan-tokens'

describe('PlanTokenRegistry', () => {
  it('issues and resolves tokens', () => {
    const reg = new PlanTokenRegistry()
    const token = reg.issue('b1', 's1', '/tmp/plan.md')
    expect(token).toHaveLength(8)

    const resolved = reg.resolve(token)
    expect(resolved).toEqual({
      bindingId: 'b1',
      sessionId: 's1',
      planPath: '/tmp/plan.md',
      messageId: undefined,
      createdAt: expect.any(Number),
    })
  })

  it('returns null for unknown tokens', () => {
    const reg = new PlanTokenRegistry()
    expect(reg.resolve('nope')).toBeNull()
  })

  it('expires tokens after TTL', async () => {
    const reg = new PlanTokenRegistry(10) // 10ms TTL for the test
    const token = reg.issue('b1', 's1', '/tmp/plan.md')
    await new Promise((r) => setTimeout(r, 20))
    expect(reg.resolve(token)).toBeNull()
  })

  it('drops the token from storage after expiry', async () => {
    const reg = new PlanTokenRegistry(5)
    const token = reg.issue('b1', 's1', '/tmp/plan.md')
    expect(reg.size()).toBe(1)
    await new Promise((r) => setTimeout(r, 15))
    reg.resolve(token) // triggers cleanup
    expect(reg.size()).toBe(0)
  })

  it('revokes previous tokens for the same binding on re-issue', () => {
    const reg = new PlanTokenRegistry()
    const t1 = reg.issue('b1', 's1', '/plan-a.md')
    const t2 = reg.issue('b1', 's1', '/plan-b.md')

    expect(reg.resolve(t1)).toBeNull()
    expect(reg.resolve(t2)?.planPath).toBe('/plan-b.md')
  })

  it('does NOT invalidate a sibling binding on the same session when a new plan is issued', () => {
    // This is the regression case. Before: `revokeForSession` wiped every
    // binding's token on the first plan event fan-out. After: each binding
    // keeps its own live token until a new plan is issued for *that*
    // binding specifically.
    const reg = new PlanTokenRegistry()
    const tA = reg.issue('binding-a', 'session-1', '/plan-a.md')
    const tB = reg.issue('binding-b', 'session-1', '/plan-b.md')

    expect(reg.resolve(tA)?.planPath).toBe('/plan-a.md')
    expect(reg.resolve(tB)?.planPath).toBe('/plan-b.md')
  })

  it('revokeForBinding removes only that binding\'s tokens', () => {
    const reg = new PlanTokenRegistry()
    const tA = reg.issue('binding-a', 'session-1', '/a.md')
    const tB = reg.issue('binding-b', 'session-1', '/b.md')

    reg.revokeForBinding('binding-a')
    expect(reg.resolve(tA)).toBeNull()
    expect(reg.resolve(tB)?.bindingId).toBe('binding-b')
  })

  it('explicit revoke removes one token only', () => {
    const reg = new PlanTokenRegistry()
    const t1 = reg.issue('b1', 's1', '/a.md')
    const t2 = reg.issue('b2', 's2', '/b.md')
    reg.revoke(t1)
    expect(reg.resolve(t1)).toBeNull()
    expect(reg.resolve(t2)).not.toBeNull()
  })

  it('keeps different sessions independent', () => {
    const reg = new PlanTokenRegistry()
    const t1 = reg.issue('b1', 's1', '/a.md')
    const t2 = reg.issue('b2', 's2', '/b.md')

    reg.revokeForBinding('b1')
    expect(reg.resolve(t1)).toBeNull()
    expect(reg.resolve(t2)?.sessionId).toBe('s2')
  })
})
