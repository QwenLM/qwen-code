import { describe, it, expect } from 'bun:test'
import {
  buildCollapsedGroupsScopeSuffix,
  serializeSessionFilterForScope,
} from '../session-list-collapse'

describe('serializeSessionFilterForScope', () => {
  it('serializes simple filter kinds', () => {
    expect(serializeSessionFilterForScope({ kind: 'allSessions' })).toBe('allSessions')
    expect(serializeSessionFilterForScope({ kind: 'flagged' })).toBe('flagged')
    expect(serializeSessionFilterForScope({ kind: 'archived' })).toBe('archived')
  })

  it('serializes id-based filters with stable prefixes', () => {
    expect(serializeSessionFilterForScope({ kind: 'state', stateId: 'in-progress' })).toBe('state:in-progress')
    expect(serializeSessionFilterForScope({ kind: 'label', labelId: 'priority/high' })).toBe('label:priority%2Fhigh')
    expect(serializeSessionFilterForScope({ kind: 'view', viewId: 'mine+active' })).toBe('view:mine%2Bactive')
  })
})

describe('buildCollapsedGroupsScopeSuffix', () => {
  it('creates different keys for different filters and grouping modes', () => {
    const inProgressDate = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'ws-1',
      currentFilter: { kind: 'state', stateId: 'in-progress' },
      groupingMode: 'date',
    })

    const inProgressStatus = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'ws-1',
      currentFilter: { kind: 'state', stateId: 'in-progress' },
      groupingMode: 'status',
    })

    const doneDate = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'ws-1',
      currentFilter: { kind: 'state', stateId: 'done' },
      groupingMode: 'date',
    })

    expect(inProgressDate).not.toBe(inProgressStatus)
    expect(inProgressDate).not.toBe(doneDate)
  })

  it('creates different keys across workspaces', () => {
    const ws1 = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'workspace-one',
      currentFilter: { kind: 'allSessions' },
      groupingMode: 'date',
    })

    const ws2 = buildCollapsedGroupsScopeSuffix({
      workspaceId: 'workspace-two',
      currentFilter: { kind: 'allSessions' },
      groupingMode: 'date',
    })

    expect(ws1).not.toBe(ws2)
  })
})
