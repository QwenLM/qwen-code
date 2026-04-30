/**
 * Tests for resolveFileMentions — semantic wrapper for @ file/folder mentions.
 *
 * Regression test for #293: file mentions sent to agent as bare paths
 * with no semantic signal, making them indistinguishable from incidental text.
 */
import { describe, it, expect } from 'bun:test'
import { resolveFileMentions } from '../index.ts'

const WORK_DIR = '/Users/me/project'

describe('resolveFileMentions', () => {
  describe('file mentions', () => {
    it('wraps relative file path in semantic marker', () => {
      expect(resolveFileMentions('[file:src/index.ts] refactor this', WORK_DIR))
        .toBe('[Mentioned file: index.ts (at /Users/me/project/src/index.ts)] refactor this')
    })

    it('wraps absolute file path in semantic marker', () => {
      expect(resolveFileMentions('[file:/tmp/test.txt] check this', WORK_DIR))
        .toBe('[Mentioned file: test.txt (at /tmp/test.txt)] check this')
    })

    it('wraps home-relative file path in semantic marker', () => {
      expect(resolveFileMentions('[file:~/docs/notes.md] read this', WORK_DIR))
        .toBe('[Mentioned file: notes.md (at ~/docs/notes.md)] read this')
    })

    it('handles file at root of working directory', () => {
      expect(resolveFileMentions('[file:package.json] what is in this?', WORK_DIR))
        .toBe('[Mentioned file: package.json (at /Users/me/project/package.json)] what is in this?')
    })

    it('handles multiple file mentions', () => {
      const input = '[file:a.ts] and [file:b.ts] compare these'
      const result = resolveFileMentions(input, WORK_DIR)
      expect(result).toContain('[Mentioned file: a.ts (at /Users/me/project/a.ts)]')
      expect(result).toContain('[Mentioned file: b.ts (at /Users/me/project/b.ts)]')
      expect(result).toContain('compare these')
    })

    it('handles file path with spaces', () => {
      expect(resolveFileMentions('[file:/Users/me/My Project/file.ts] update', WORK_DIR))
        .toBe('[Mentioned file: file.ts (at /Users/me/My Project/file.ts)] update')
    })
  })

  describe('folder mentions', () => {
    it('wraps relative folder path in semantic marker', () => {
      expect(resolveFileMentions('[folder:src/components] explore', WORK_DIR))
        .toBe('[Mentioned folder: components (at /Users/me/project/src/components)] explore')
    })

    it('wraps absolute folder path in semantic marker', () => {
      expect(resolveFileMentions('[folder:/tmp/output] list files', WORK_DIR))
        .toBe('[Mentioned folder: output (at /tmp/output)] list files')
    })
  })

  describe('mixed mentions', () => {
    it('resolves both file and folder mentions in same message', () => {
      const input = '[file:index.ts] and [folder:src] check both'
      const result = resolveFileMentions(input, WORK_DIR)
      expect(result).toContain('[Mentioned file: index.ts')
      expect(result).toContain('[Mentioned folder: src')
    })
  })

  describe('non-mention text is preserved', () => {
    it('does not modify text without mentions', () => {
      expect(resolveFileMentions('just a normal message', WORK_DIR))
        .toBe('just a normal message')
    })

    it('preserves paths that are not in [file:] brackets', () => {
      expect(resolveFileMentions('/Users/me/project/foo.ts is broken', WORK_DIR))
        .toBe('/Users/me/project/foo.ts is broken')
    })

    it('leaves [skill:...] and [source:...] untouched', () => {
      expect(resolveFileMentions('[skill:commit] [source:github] do work', WORK_DIR))
        .toBe('[skill:commit] [source:github] do work')
    })
  })
})
