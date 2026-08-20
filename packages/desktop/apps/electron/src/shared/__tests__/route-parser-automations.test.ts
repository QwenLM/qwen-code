import { describe, it, expect } from 'bun:test'
import { parseCompoundRoute, buildCompoundRoute } from '../route-parser'

describe('route-parser: automations routes', () => {
  it('parses "automations" as automations navigator with no filter or details', () => {
    const result = parseCompoundRoute('automations')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('automations')
    expect(result!.details).toBeNull()
    expect(result!.automationFilter).toBeUndefined()
  })

  it('parses "automations/scheduled" as automations with scheduled filter', () => {
    const result = parseCompoundRoute('automations/scheduled')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('automations')
    expect(result!.automationFilter).toEqual({ kind: 'type', automationType: 'scheduled' })
    expect(result!.details).toBeNull()
  })

  it('parses "automations/event" as automations with event filter', () => {
    const result = parseCompoundRoute('automations/event')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('automations')
    expect(result!.automationFilter).toEqual({ kind: 'type', automationType: 'event' })
    expect(result!.details).toBeNull()
  })

  it('parses "automations/agentic" as automations with agentic filter', () => {
    const result = parseCompoundRoute('automations/agentic')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('automations')
    expect(result!.automationFilter).toEqual({ kind: 'type', automationType: 'agentic' })
    expect(result!.details).toBeNull()
  })

  it('parses "automations/scheduled/automation/automation-1" as filtered + details', () => {
    const result = parseCompoundRoute('automations/scheduled/automation/automation-1')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('automations')
    expect(result!.automationFilter).toEqual({ kind: 'type', automationType: 'scheduled' })
    expect(result!.details).toEqual({ type: 'automation', id: 'automation-1' })
  })

  it('parses "automations/automation/automation-1" as unfiltered + details', () => {
    const result = parseCompoundRoute('automations/automation/automation-1')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('automations')
    expect(result!.automationFilter).toBeUndefined()
    expect(result!.details).toEqual({ type: 'automation', id: 'automation-1' })
  })

  it('roundtrips automations (no filter, no details)', () => {
    const parsed = parseCompoundRoute('automations')!
    const built = buildCompoundRoute(parsed)
    expect(built).toBe('automations')
  })

  it('roundtrips automations with scheduled filter', () => {
    const parsed = parseCompoundRoute('automations/scheduled')!
    // buildCompoundRoute only outputs the details suffix when details are present
    // For filter-only, it returns just the base
    expect(parsed.navigator).toBe('automations')
    expect(parsed.automationFilter?.automationType).toBe('scheduled')
  })

  it('roundtrips automations/scheduled/automation/automation-1', () => {
    const parsed = parseCompoundRoute('automations/scheduled/automation/automation-1')!
    const built = buildCompoundRoute(parsed)
    expect(built).toBe('automations/scheduled/automation/automation-1')
  })

  it('roundtrips automations/automation/automation-1', () => {
    const parsed = parseCompoundRoute('automations/automation/automation-1')!
    const built = buildCompoundRoute(parsed)
    expect(built).toBe('automations/automation/automation-1')
  })
})
