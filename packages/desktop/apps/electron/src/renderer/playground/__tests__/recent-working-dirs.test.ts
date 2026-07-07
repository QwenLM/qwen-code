import { describe, it, expect } from 'bun:test'
import { getRecentDirsForScenario } from '../recent-working-dirs'

describe('playground recent working dirs fixtures', () => {
  it('returns empty list for none scenario', () => {
    expect(getRecentDirsForScenario('none')).toEqual([])
  })

  it('returns populated list for few scenario', () => {
    const few = getRecentDirsForScenario('few')
    expect(few.length).toBeGreaterThan(0)
    expect(new Set(few).size).toBe(few.length)
  })

  it('returns >5 entries for many scenario (enables filter UI path)', () => {
    const many = getRecentDirsForScenario('many')
    expect(many.length).toBeGreaterThan(5)
    expect(new Set(many).size).toBe(many.length)
  })
})
