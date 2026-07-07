/**
 * Tests for sanitizeForTitle from sessions.ts
 *
 * Tests the exported sanitizeForTitle function which strips bracket-mentions,
 * XML, and normalizes whitespace for session title generation.
 */
import { describe, it, expect } from 'bun:test'
import { sanitizeForTitle } from '@craft-agent/server-core/domain'

// ============================================================================
// sanitizeForTitle — bracket mention stripping
// ============================================================================

describe('sanitizeForTitle', () => {
  describe('skill mentions', () => {
    it('strips [skill:slug] format', () => {
      expect(sanitizeForTitle('[skill:commit] fix the bug')).toBe('fix the bug')
    })

    it('strips [skill:workspace:slug] format', () => {
      expect(sanitizeForTitle('[skill:my-workspace:commit] fix the bug')).toBe('fix the bug')
    })

    it('strips multiple skill mentions', () => {
      expect(sanitizeForTitle('[skill:commit] [skill:review-pr] do both')).toBe('do both')
    })

    it('strips skill with underscore in slug', () => {
      expect(sanitizeForTitle('[skill:my_skill] hello')).toBe('hello')
    })

    it('strips skill with hyphen in workspace and slug', () => {
      expect(sanitizeForTitle('[skill:my-ws:my-skill] hello')).toBe('hello')
    })

    it('strips skill with dotted workspace ID', () => {
      expect(sanitizeForTitle('[skill:my.workspace:commit] fix the bug')).toBe('fix the bug')
    })

    it('strips skill with space in workspace ID', () => {
      expect(sanitizeForTitle('[skill:My Workspace:commit] fix the bug')).toBe('fix the bug')
    })
  })

  describe('source mentions', () => {
    it('strips [source:slug] format', () => {
      expect(sanitizeForTitle('[source:github] check PRs')).toBe('check PRs')
    })

    it('strips source with hyphens', () => {
      expect(sanitizeForTitle('[source:my-source] query data')).toBe('query data')
    })
  })

  describe('file mentions', () => {
    it('strips [file:/path/to/file]', () => {
      expect(sanitizeForTitle('[file:/Users/me/project/index.ts] refactor this')).toBe('refactor this')
    })

    it('strips file with spaces in path', () => {
      expect(sanitizeForTitle('[file:/Users/me/My Project/file.ts] update')).toBe('update')
    })

    it('strips file with dots and hyphens', () => {
      expect(sanitizeForTitle('[file:/a/b/my-file.test.ts] fix test')).toBe('fix test')
    })
  })

  describe('folder mentions', () => {
    it('strips [folder:/path/to/dir]', () => {
      expect(sanitizeForTitle('[folder:/Users/me/project] explore')).toBe('explore')
    })

    it('strips folder with complex path', () => {
      expect(sanitizeForTitle('[folder:/a/b/c/my-dir] list files')).toBe('list files')
    })
  })

  describe('preserves normal brackets', () => {
    it('preserves markdown link syntax', () => {
      expect(sanitizeForTitle('check [link text](http://example.com)')).toBe('check [link text](http://example.com)')
    })

    it('preserves array syntax', () => {
      expect(sanitizeForTitle('use [1, 2, 3] for input')).toBe('use [1, 2, 3] for input')
    })

    it('preserves brackets with spaces', () => {
      expect(sanitizeForTitle('see [this section] for details')).toBe('see [this section] for details')
    })
  })

  describe('XML/HTML stripping', () => {
    it('strips edit_request blocks', () => {
      expect(sanitizeForTitle('<edit_request>some\nmultiline\ncontent</edit_request> after')).toBe('after')
    })

    it('strips generic HTML tags', () => {
      expect(sanitizeForTitle('<b>bold</b> text')).toBe('bold text')
    })

    it('strips self-closing tags', () => {
      expect(sanitizeForTitle('before <br/> after')).toBe('before after')
    })
  })

  describe('whitespace normalization', () => {
    it('collapses multiple spaces', () => {
      expect(sanitizeForTitle('hello    world')).toBe('hello world')
    })

    it('collapses newlines and tabs', () => {
      expect(sanitizeForTitle('hello\n\tworld')).toBe('hello world')
    })

    it('trims leading and trailing whitespace', () => {
      expect(sanitizeForTitle('  hello world  ')).toBe('hello world')
    })

    it('handles whitespace left after stripping mentions', () => {
      expect(sanitizeForTitle('[skill:commit]   [source:github]   do work')).toBe('do work')
    })
  })

  describe('multiple mentions in one title', () => {
    it('strips mixed mention types', () => {
      expect(sanitizeForTitle('[skill:commit] [source:github] [file:/a/b.ts] fix everything')).toBe('fix everything')
    })

    it('strips mentions interspersed with text', () => {
      expect(sanitizeForTitle('use [skill:commit] and [source:github] to fix [file:/a.ts]')).toBe('use and to fix')
    })
  })

  describe('edge cases', () => {
    it('returns empty string when only mentions present', () => {
      expect(sanitizeForTitle('[skill:commit] [source:github]')).toBe('')
    })

    it('handles empty string', () => {
      expect(sanitizeForTitle('')).toBe('')
    })

    it('handles empty brackets []', () => {
      // Empty brackets don't match any mention pattern, so they're preserved
      expect(sanitizeForTitle('[] hello')).toBe('[] hello')
    })

    it('handles nested brackets [[skill:ws:x]]', () => {
      // The inner [skill:ws:x] is stripped, leaving the outer brackets
      expect(sanitizeForTitle('[[skill:ws:x]] test')).toBe('[] test')
    })

    it('handles unicode content alongside mentions', () => {
      expect(sanitizeForTitle('[skill:commit] fix the bug with emoji: 🐛')).toBe('fix the bug with emoji: 🐛')
    })

    it('handles CJK characters alongside mentions', () => {
      expect(sanitizeForTitle('[source:github] 修复这个问题')).toBe('修复这个问题')
    })

    it('handles only whitespace after stripping', () => {
      expect(sanitizeForTitle('[skill:commit]   ')).toBe('')
    })
  })

  describe('badge label substitution (title generation flow)', () => {
    // In the real code, badge substitution happens BEFORE sanitizeForTitle:
    // 1. Replace badge.rawText with badge.label
    // 2. Then sanitize remaining mentions

    it('substitutes badge label before sanitization', () => {
      let title = '[skill:workspace:commit] fix the tests'
      const badges = [{ rawText: '[skill:workspace:commit]', label: 'Commit' }]

      // Step 1: badge substitution (as done in sessions.ts)
      for (const badge of badges) {
        if (badge.rawText && badge.label) {
          title = title.replace(badge.rawText, badge.label)
        }
      }

      // Step 2: sanitize remaining mentions
      const result = sanitizeForTitle(title)
      expect(result).toBe('Commit fix the tests')
    })

    it('substitutes multiple badges', () => {
      let title = '[skill:ws:commit] and [source:github] review'
      const badges = [
        { rawText: '[skill:ws:commit]', label: 'Commit' },
        { rawText: '[source:github]', label: 'GitHub' },
      ]

      for (const badge of badges) {
        if (badge.rawText && badge.label) {
          title = title.replace(badge.rawText, badge.label)
        }
      }

      const result = sanitizeForTitle(title)
      expect(result).toBe('Commit and GitHub review')
    })

    it('strips unmatched mentions after badge substitution', () => {
      let title = '[skill:ws:commit] [file:/path/to/file.ts] fix this'
      const badges = [{ rawText: '[skill:ws:commit]', label: 'Commit' }]

      for (const badge of badges) {
        if (badge.rawText && badge.label) {
          title = title.replace(badge.rawText, badge.label)
        }
      }

      const result = sanitizeForTitle(title)
      expect(result).toBe('Commit fix this')
    })

    it('handles badge with no rawText gracefully', () => {
      let title = '[skill:commit] hello'
      const badges = [{ rawText: '', label: 'Commit' }]

      for (const badge of badges) {
        if (badge.rawText && badge.label) {
          title = title.replace(badge.rawText, badge.label)
        }
      }

      const result = sanitizeForTitle(title)
      expect(result).toBe('hello')
    })
  })
})
