import { describe, expect, it } from 'bun:test'
import { tokenMatches } from './voice-server'

describe('tokenMatches', () => {
  it('accepts the exact token only', () => {
    expect(tokenMatches('secret-token', 'secret-token')).toBe(true)
    expect(tokenMatches(null, 'secret-token')).toBe(false)
    expect(tokenMatches('wrong-token', 'secret-token')).toBe(false)
    expect(tokenMatches('secret-token-extra', 'secret-token')).toBe(false)
  })
})
