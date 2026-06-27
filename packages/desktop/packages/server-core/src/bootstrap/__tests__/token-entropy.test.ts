import { describe, it, expect } from 'bun:test'
import { generateServerToken } from '../headless-start'

/**
 * We can't directly import validateTokenEntropy (it's not exported),
 * but we can test it indirectly through bootstrapServer's behavior.
 * For the entropy check, we test generateServerToken quality and
 * validate the function's contract through integration.
 */

describe('generateServerToken', () => {
  it('produces a 48-character hex string', () => {
    const token = generateServerToken()
    expect(token).toHaveLength(48)
    expect(token).toMatch(/^[0-9a-f]{48}$/)
  })

  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateServerToken()))
    expect(tokens.size).toBe(100)
  })

  it('has high character diversity', () => {
    const token = generateServerToken()
    const uniqueChars = new Set(token).size
    // 48 hex chars should have good diversity (16 possible chars)
    expect(uniqueChars).toBeGreaterThan(8)
  })
})
