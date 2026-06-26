import { describe, it, expect } from 'bun:test'
import {
  MAX_RECENT_WORKING_DIRS,
  addPathToRecentWorkingDirs,
  removePathFromRecentWorkingDirs,
  normalizeRecentWorkingDirs,
} from '../working-directory-history'

describe('working-directory-history', () => {
  describe('addPathToRecentWorkingDirs', () => {
    it('adds new directory to the front', () => {
      const result = addPathToRecentWorkingDirs(['/a', '/b'], '/c')
      expect(result).toEqual(['/c', '/a', '/b'])
    })

    it('moves existing directory to the front without duplicates', () => {
      const result = addPathToRecentWorkingDirs(['/a', '/b', '/c'], '/b')
      expect(result).toEqual(['/b', '/a', '/c'])
    })

    it('caps list length to MAX_RECENT_WORKING_DIRS', () => {
      const existing = Array.from({ length: MAX_RECENT_WORKING_DIRS }, (_, i) => `/dir-${i}`)
      const result = addPathToRecentWorkingDirs(existing, '/new-dir')

      expect(result.length).toBe(MAX_RECENT_WORKING_DIRS)
      expect(result[0]).toBe('/new-dir')
      expect(result).not.toContain(`/dir-${MAX_RECENT_WORKING_DIRS - 1}`)
    })

    it('ignores empty/whitespace paths', () => {
      const existing = ['/a', '/b']
      expect(addPathToRecentWorkingDirs(existing, '')).toEqual(existing)
      expect(addPathToRecentWorkingDirs(existing, '   ')).toEqual(existing)
    })
  })

  describe('removePathFromRecentWorkingDirs', () => {
    it('removes only the target directory', () => {
      const result = removePathFromRecentWorkingDirs(['/a', '/b', '/c'], '/b')
      expect(result).toEqual(['/a', '/c'])
    })

    it('returns unchanged list when path does not exist', () => {
      const existing = ['/a', '/b']
      expect(removePathFromRecentWorkingDirs(existing, '/x')).toEqual(existing)
    })
  })

  describe('normalizeRecentWorkingDirs', () => {
    it('trims, deduplicates, drops empties, and preserves first-seen order', () => {
      const result = normalizeRecentWorkingDirs([' /a ', '', '/b', '   ', '/a', '/c'])
      expect(result).toEqual(['/a', '/b', '/c'])
    })

    it('caps normalized list length', () => {
      const paths = Array.from({ length: MAX_RECENT_WORKING_DIRS + 10 }, (_, i) => `/dir-${i}`)
      const result = normalizeRecentWorkingDirs(paths)
      expect(result.length).toBe(MAX_RECENT_WORKING_DIRS)
      expect(result[0]).toBe('/dir-0')
      expect(result[MAX_RECENT_WORKING_DIRS - 1]).toBe(`/dir-${MAX_RECENT_WORKING_DIRS - 1}`)
    })
  })
})
