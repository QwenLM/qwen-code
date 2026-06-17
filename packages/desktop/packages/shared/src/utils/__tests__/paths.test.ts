import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { expandPath } from '../paths.ts'

describe('expandPath', () => {
  it('expands Windows-style tilde paths under home', () => {
    expect(expandPath('~\\.craft-agent\\foo')).toBe(
      join(homedir(), '.craft-agent', 'foo'),
    )
  })

  it('expands bare Windows-style tilde prefixes', () => {
    expect(expandPath('~\\')).toBe(normalize(homedir()))
  })

  it('keeps existing home expansion behavior', () => {
    expect(expandPath('~')).toBe(homedir())
    expect(expandPath('~/Documents')).toBe(join(homedir(), 'Documents'))
    expect(expandPath('${HOME}/projects')).toBe(join(homedir(), 'projects'))
    expect(expandPath('$HOME/projects')).toBe(join(homedir(), 'projects'))
  })

  it('keeps absolute and relative path behavior unchanged', () => {
    const absolutePath = join(homedir(), 'already-absolute')
    const basePath = join(homedir(), 'base')

    expect(expandPath(absolutePath, basePath)).toBe(normalize(absolutePath))
    expect(expandPath('relative/path', basePath)).toBe(
      resolve(basePath, 'relative/path'),
    )
  })
})
