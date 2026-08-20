import { describe, expect, it } from 'bun:test'
import { getNextPermissionMode, getPermissionModeCycle } from '../permission-mode-cycle'

describe('permission mode cycling', () => {
  it('uses the full permission mode order by default', () => {
    expect(getPermissionModeCycle()).toEqual(['allow-all', 'safe', 'ask', 'auto-edit'])
  })

  it('cycles through enabled modes in order', () => {
    expect(getNextPermissionMode('allow-all', ['allow-all', 'ask'])).toBe('ask')
    expect(getNextPermissionMode('ask', ['allow-all', 'ask'])).toBe('allow-all')
  })

  it('jumps to the first enabled mode when the current mode is disabled', () => {
    expect(getNextPermissionMode('safe', ['allow-all', 'ask'])).toBe('allow-all')
  })

  it('falls back to the full order when fewer than two enabled modes are provided', () => {
    expect(getNextPermissionMode('allow-all', ['allow-all'])).toBe('safe')
  })
})
