import { describe, expect, it } from 'bun:test'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { formatSinglePathToRelative } from '../files.ts'

describe('formatSinglePathToRelative', () => {
  it('formats paths inside cwd as relative paths', () => {
    const cwd = join(tmpdir(), 'qwen-format-path-project')
    const filePath = join(cwd, 'src', 'index.ts')

    expect(formatSinglePathToRelative(filePath, cwd)).toBe(
      `./${relative(cwd, filePath)}`,
    )
  })

  it('keeps sibling directories with the same prefix absolute', () => {
    const cwd = join(tmpdir(), 'qwen-format-path-project')
    const siblingPath = join(`${cwd}-other`, 'src', 'index.ts')

    expect(formatSinglePathToRelative(siblingPath, cwd)).toBe(siblingPath)
  })

  it('formats paths whose segment starts with double dots but stays inside cwd', () => {
    const cwd = join(tmpdir(), 'qwen-format-path-project')
    const filePath = join(cwd, '..notes.md')

    expect(formatSinglePathToRelative(filePath, cwd)).toBe(
      `./${relative(cwd, filePath)}`,
    )
  })
})
