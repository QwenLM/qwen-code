import { describe, it, expect } from 'bun:test'
import {
  getStateIconStyle,
  getStatusIconStyle,
  type SessionStatus,
} from '../session-status-config'

function makeStatus(overrides: Partial<SessionStatus>): SessionStatus {
  return {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--foreground)',
    icon: '●',
    iconColorable: true,
    ...overrides,
  }
}

describe('session-status-config icon style helpers', () => {
  it('getStatusIconStyle returns color style for colorable icons', () => {
    const status = makeStatus({ iconColorable: true, resolvedColor: 'var(--accent)' })

    expect(getStatusIconStyle(status)).toEqual({ color: 'var(--accent)' })
  })

  it('getStatusIconStyle returns undefined for non-colorable icons (emoji/images)', () => {
    const status = makeStatus({ icon: '✅', iconColorable: false, resolvedColor: 'var(--foreground)' })

    expect(getStatusIconStyle(status)).toBeUndefined()
  })

  it('getStateIconStyle resolves by id and applies same colorability rule', () => {
    const states: SessionStatus[] = [
      makeStatus({ id: 'todo', icon: '✅', iconColorable: false, resolvedColor: 'var(--foreground)' }),
      makeStatus({ id: 'in-progress', iconColorable: true, resolvedColor: 'var(--success)' }),
    ]

    expect(getStateIconStyle('todo', states)).toBeUndefined()
    expect(getStateIconStyle('in-progress', states)).toEqual({ color: 'var(--success)' })
    expect(getStateIconStyle('missing', states)).toBeUndefined()
  })
})
