import { describe, it, expect } from 'bun:test'

import {
  normalizeBrowserToolName,
  getBrowserToolCommandVerb,
  shouldActivateBrowserOverlay,
} from '@craft-agent/server-core/domain'

describe('browser-tool-detection', () => {
  describe('normalizeBrowserToolName', () => {
    it('normalizes direct and namespaced browser_tool names only', () => {
      expect(normalizeBrowserToolName('browser_tool')).toBe('browser_tool')
      expect(normalizeBrowserToolName('mcp__session__browser_tool')).toBe('browser_tool')
      expect(normalizeBrowserToolName('mcp__workspace__browser_tool')).toBe('browser_tool')
    })

    it('returns null for non-browser_tool names', () => {
      expect(normalizeBrowserToolName('browser_open')).toBeNull()
      expect(normalizeBrowserToolName('mcp__session__browser_snapshot')).toBeNull()
      expect(normalizeBrowserToolName('mcp__session__read')).toBeNull()
      expect(normalizeBrowserToolName('write')).toBeNull()
      expect(normalizeBrowserToolName('')).toBeNull()
    })
  })

  describe('getBrowserToolCommandVerb', () => {
    it('extracts normalized command verbs', () => {
      expect(getBrowserToolCommandVerb({ command: 'release' })).toBe('release')
      expect(getBrowserToolCommandVerb({ command: '  SNAPSHOT   ' })).toBe('snapshot')
      expect(getBrowserToolCommandVerb({ command: '--help' })).toBe('--help')
      expect(getBrowserToolCommandVerb({ command: 'navigate https://example.com' })).toBe('navigate')
    })

    it('returns empty string for invalid inputs', () => {
      expect(getBrowserToolCommandVerb({})).toBe('')
      expect(getBrowserToolCommandVerb({ command: 123 })).toBe('')
      expect(getBrowserToolCommandVerb(null)).toBe('')
    })
  })

  describe('shouldActivateBrowserOverlay', () => {
    it('does not activate for non-browser_tool names', () => {
      expect(shouldActivateBrowserOverlay('browser_open', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_snapshot', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__read', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('write', {})).toBe(false)
    })

    it('does not activate for browser_tool help/open/release/teardown commands', () => {
      expect(shouldActivateBrowserOverlay('browser_tool', { command: '--help' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'help' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'open' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'open --foreground' })).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_tool', { command: 'release' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'close' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'hide' })).toBe(false)
    })

    it('does not activate when browser_tool command is missing', () => {
      expect(shouldActivateBrowserOverlay('browser_tool', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_tool', { command: '   ' })).toBe(false)
    })

    it('activates for browser_tool actionable commands', () => {
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'snapshot' })).toBe(true)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_tool', { command: 'navigate https://linear.app' })).toBe(true)
    })
  })
})
