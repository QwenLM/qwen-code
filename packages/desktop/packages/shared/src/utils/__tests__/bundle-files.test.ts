import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  collectDirectoryFiles,
  restoreFiles,
  validateBundleFile,
  toPortableRelPath,
  fromPortableRelPath,
  type BundleFile,
} from '../bundle-files'

describe('bundle-files', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `bundle-files-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true })
    }
  })

  // ============================================================
  // Path portability
  // ============================================================

  describe('toPortableRelPath', () => {
    it('normalizes forward slashes (no-op on POSIX)', () => {
      expect(toPortableRelPath('subdir/file.txt')).toBe('subdir/file.txt')
    })

    it('handles single file name', () => {
      expect(toPortableRelPath('file.txt')).toBe('file.txt')
    })
  })

  describe('fromPortableRelPath', () => {
    it('converts back to native (no-op on POSIX)', () => {
      const portable = 'subdir/file.txt'
      const native = fromPortableRelPath(portable)
      // On POSIX, this is identity; on Windows it would use backslashes
      expect(native).toContain('file.txt')
    })
  })

  // ============================================================
  // Validation
  // ============================================================

  describe('validateBundleFile', () => {
    it('accepts a valid file', () => {
      const content = Buffer.from('hello world')
      const file: BundleFile = {
        relativePath: 'test.txt',
        contentBase64: content.toString('base64'),
        size: content.length,
      }
      expect(validateBundleFile(file)).toBeNull()
    })

    it('rejects path traversal (..)', () => {
      const file: BundleFile = {
        relativePath: '../etc/passwd',
        contentBase64: Buffer.from('x').toString('base64'),
        size: 1,
      }
      expect(validateBundleFile(file)).toContain('Path traversal')
    })

    it('rejects absolute paths', () => {
      const file: BundleFile = {
        relativePath: '/etc/passwd',
        contentBase64: Buffer.from('x').toString('base64'),
        size: 1,
      }
      expect(validateBundleFile(file)).toContain('Absolute path')
    })

    it('rejects backslash paths', () => {
      const file: BundleFile = {
        relativePath: 'sub\\file.txt',
        contentBase64: Buffer.from('x').toString('base64'),
        size: 1,
      }
      expect(validateBundleFile(file)).toContain('Backslash')
    })

    it('rejects double slashes', () => {
      const file: BundleFile = {
        relativePath: 'sub//file.txt',
        contentBase64: Buffer.from('x').toString('base64'),
        size: 1,
      }
      expect(validateBundleFile(file)).toContain('double slash')
    })

    it('rejects size mismatch', () => {
      const content = Buffer.from('hello')
      const file: BundleFile = {
        relativePath: 'test.txt',
        contentBase64: content.toString('base64'),
        size: 999,
      }
      expect(validateBundleFile(file)).toContain('Size mismatch')
    })

    it('rejects empty relativePath', () => {
      const file: BundleFile = {
        relativePath: '',
        contentBase64: Buffer.from('x').toString('base64'),
        size: 1,
      }
      expect(validateBundleFile(file)).toContain('Missing')
    })
  })

  // ============================================================
  // Collection
  // ============================================================

  describe('collectDirectoryFiles', () => {
    it('collects files recursively', () => {
      mkdirSync(join(tmpDir, 'sub'), { recursive: true })
      writeFileSync(join(tmpDir, 'root.txt'), 'root')
      writeFileSync(join(tmpDir, 'sub', 'nested.txt'), 'nested')

      const files = collectDirectoryFiles(tmpDir)
      expect(files).toHaveLength(2)

      const paths = files.map(f => f.relativePath)
      expect(paths).toContain('root.txt')
      expect(paths).toContain('sub/nested.txt')
    })

    it('skips hidden files and directories', () => {
      mkdirSync(join(tmpDir, '.hidden'), { recursive: true })
      writeFileSync(join(tmpDir, '.dotfile'), 'hidden')
      writeFileSync(join(tmpDir, '.hidden', 'secret.txt'), 'secret')
      writeFileSync(join(tmpDir, 'visible.txt'), 'visible')

      const files = collectDirectoryFiles(tmpDir)
      expect(files).toHaveLength(1)
      expect(files[0]!.relativePath).toBe('visible.txt')
    })

    it('respects skipFiles option', () => {
      writeFileSync(join(tmpDir, 'config.json'), '{}')
      writeFileSync(join(tmpDir, 'guide.md'), '# Guide')

      const files = collectDirectoryFiles(tmpDir, {
        skipFiles: new Set(['config.json']),
      })
      expect(files).toHaveLength(1)
      expect(files[0]!.relativePath).toBe('guide.md')
    })

    it('respects skipDirs option', () => {
      mkdirSync(join(tmpDir, 'tmp'), { recursive: true })
      mkdirSync(join(tmpDir, 'keep'), { recursive: true })
      writeFileSync(join(tmpDir, 'tmp', 'cache.txt'), 'cached')
      writeFileSync(join(tmpDir, 'keep', 'data.txt'), 'data')

      const files = collectDirectoryFiles(tmpDir, {
        skipDirs: new Set(['tmp']),
      })
      expect(files).toHaveLength(1)
      expect(files[0]!.relativePath).toBe('keep/data.txt')
    })

    it('produces deterministic (sorted) output', () => {
      writeFileSync(join(tmpDir, 'z.txt'), 'z')
      writeFileSync(join(tmpDir, 'a.txt'), 'a')
      writeFileSync(join(tmpDir, 'm.txt'), 'm')

      const files = collectDirectoryFiles(tmpDir)
      const paths = files.map(f => f.relativePath)
      expect(paths).toEqual(['a.txt', 'm.txt', 'z.txt'])
    })

    it('uses portable forward-slash paths', () => {
      mkdirSync(join(tmpDir, 'sub', 'deep'), { recursive: true })
      writeFileSync(join(tmpDir, 'sub', 'deep', 'file.txt'), 'content')

      const files = collectDirectoryFiles(tmpDir)
      expect(files[0]!.relativePath).toBe('sub/deep/file.txt')
      expect(files[0]!.relativePath).not.toContain('\\')
    })

    it('correctly encodes file content as base64', () => {
      const content = 'Hello, World! 🌍'
      writeFileSync(join(tmpDir, 'test.txt'), content)

      const files = collectDirectoryFiles(tmpDir)
      const decoded = Buffer.from(files[0]!.contentBase64, 'base64').toString('utf-8')
      expect(decoded).toBe(content)
    })

    it('returns empty array for non-existent directory', () => {
      const files = collectDirectoryFiles(join(tmpDir, 'nonexistent'))
      expect(files).toEqual([])
    })
  })

  // ============================================================
  // Restoration
  // ============================================================

  describe('restoreFiles', () => {
    it('restores files to target directory', () => {
      const content = Buffer.from('restored content')
      const files: BundleFile[] = [{
        relativePath: 'test.txt',
        contentBase64: content.toString('base64'),
        size: content.length,
      }]

      const target = join(tmpDir, 'target')
      mkdirSync(target)
      restoreFiles(target, files)

      expect(readFileSync(join(target, 'test.txt'), 'utf-8')).toBe('restored content')
    })

    it('creates subdirectories as needed', () => {
      const content = Buffer.from('nested')
      const files: BundleFile[] = [{
        relativePath: 'deep/nested/file.txt',
        contentBase64: content.toString('base64'),
        size: content.length,
      }]

      const target = join(tmpDir, 'target')
      mkdirSync(target)
      restoreFiles(target, files)

      expect(existsSync(join(target, 'deep', 'nested', 'file.txt'))).toBe(true)
    })

    it('throws on path traversal', () => {
      const files: BundleFile[] = [{
        relativePath: '../escape.txt',
        contentBase64: Buffer.from('x').toString('base64'),
        size: 1,
      }]

      const target = join(tmpDir, 'target')
      mkdirSync(target)
      expect(() => restoreFiles(target, files)).toThrow('Invalid bundle file')
    })

    it('throws on absolute path', () => {
      const files: BundleFile[] = [{
        relativePath: '/etc/passwd',
        contentBase64: Buffer.from('x').toString('base64'),
        size: 1,
      }]

      const target = join(tmpDir, 'target')
      mkdirSync(target)
      expect(() => restoreFiles(target, files)).toThrow('Invalid bundle file')
    })

    it('round-trips with collectDirectoryFiles', () => {
      // Create source structure
      const sourceDir = join(tmpDir, 'source')
      mkdirSync(join(sourceDir, 'sub'), { recursive: true })
      writeFileSync(join(sourceDir, 'readme.md'), '# Hello')
      writeFileSync(join(sourceDir, 'sub', 'script.ts'), 'console.log("hi")')

      // Collect
      const files = collectDirectoryFiles(sourceDir)

      // Restore to different location
      const targetDir = join(tmpDir, 'target')
      mkdirSync(targetDir)
      restoreFiles(targetDir, files)

      // Verify
      expect(readFileSync(join(targetDir, 'readme.md'), 'utf-8')).toBe('# Hello')
      expect(readFileSync(join(targetDir, 'sub', 'script.ts'), 'utf-8')).toBe('console.log("hi")')
    })
  })
})
