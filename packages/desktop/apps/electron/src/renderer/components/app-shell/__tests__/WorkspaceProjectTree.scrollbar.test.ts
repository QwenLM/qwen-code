import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const here = dirname(fileURLToPath(import.meta.url))

describe('WorkspaceProjectTree scrollbar gutter', () => {
  it('reserves scrollbar space on the project list scroll container', () => {
    const component = readFileSync(
      resolve(here, '../WorkspaceProjectTree.tsx'),
      'utf8',
    )
    const css = readFileSync(resolve(here, '../../../index.css'), 'utf8')

    expect(component).toContain('mask-fade-bottom scrollbar-stable')
    expect(css).toContain('.scrollbar-stable')
    expect(css).toContain('scrollbar-gutter: stable')
  })
})
