import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'

describe('route-parser: skill marketplace routes', () => {
  it('parses skillMarketplace as the skill marketplace navigator', () => {
    const result = parseCompoundRoute('skillMarketplace')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('skillMarketplace')
    expect(result!.details).toBeNull()
  })

  it('converts skillMarketplace to navigation state', () => {
    expect(parseRouteToNavigationState('skillMarketplace')).toEqual({
      navigator: 'skillMarketplace',
      details: null,
    })
  })

  it('roundtrips skillMarketplace', () => {
    const parsed = parseCompoundRoute('skillMarketplace')!
    expect(buildCompoundRoute(parsed)).toBe('skillMarketplace')
    expect(
      buildRouteFromNavigationState({
        navigator: 'skillMarketplace',
        details: null,
      }),
    ).toBe('skillMarketplace')
  })

  it('roundtrips a selected marketplace skill', () => {
    const parsed = parseCompoundRoute('skillMarketplace/skill/pptx')
    expect(parsed).toEqual({
      navigator: 'skillMarketplace',
      details: { type: 'marketplaceSkill', id: 'pptx' },
    })
    expect(parseRouteToNavigationState('skillMarketplace/skill/pptx')).toEqual({
      navigator: 'skillMarketplace',
      details: { type: 'marketplaceSkill', skillId: 'pptx' },
    })
    expect(
      buildRouteFromNavigationState({
        navigator: 'skillMarketplace',
        details: { type: 'marketplaceSkill', skillId: 'pptx' },
      }),
    ).toBe('skillMarketplace/skill/pptx')
  })
})
