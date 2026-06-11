import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isGitBashExecutablePath, isUsableGitBashPath, validateGitBashPath } from '@craft-agent/server-core/services'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'git-bash-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('git-bash helpers', () => {
  it('recognizes bash.exe paths with different separators', () => {
    expect(isGitBashExecutablePath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true)
    expect(isGitBashExecutablePath('/tmp/git/bin/bash.exe')).toBe(true)
    expect(isGitBashExecutablePath('/tmp/git/bin/sh.exe')).toBe(false)
  })

  it('rejects non-bash executable names', async () => {
    const fakePath = join(tempDir, 'cmd.exe')
    writeFileSync(fakePath, 'echo test')

    const result = await validateGitBashPath(fakePath)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('Path must point to bash.exe')
    }
  })

  it('rejects missing bash.exe paths', async () => {
    const result = await validateGitBashPath(join(tempDir, 'bash.exe'))
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toBe('File does not exist at the specified path')
    }
  })

  it('accepts existing bash.exe files', async () => {
    const bashPath = join(tempDir, 'bash.exe')
    writeFileSync(bashPath, 'echo bash')

    const result = await validateGitBashPath(bashPath)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.path).toBe(bashPath)
    }
    await expect(isUsableGitBashPath(bashPath)).resolves.toBe(true)
  })
})
