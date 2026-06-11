import { describe, expect, it } from 'bun:test'
import { Linter } from 'eslint'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rule = require('../no-floating-z-tokens-in-island.cjs')

function runRule(code: string, filename: string) {
  const linter = new Linter({ configType: 'eslintrc' })
  linter.defineRule('craft-styles/no-floating-z-tokens-in-island', rule)

  return linter.verify(code, {
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'craft-styles/no-floating-z-tokens-in-island': 'error',
    },
  }, filename)
}

describe('no-floating-z-tokens-in-island (ui)', () => {
  it('flags floating menu token in AnnotationIslandMenu', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-floating-menu, 400)'",
      '/repo/packages/ui/src/components/annotations/AnnotationIslandMenu.tsx',
    )

    expect(messages.length).toBe(1)
    expect(messages[0]?.message).toContain('Use island z-index tokens')
  })

  it('flags floating backdrop token in island contexts', () => {
    const messages = runRule(
      "const overlayZIndex = 'var(--z-floating-backdrop, 390)'",
      '/repo/packages/ui/src/components/ui/Island.tsx',
    )

    expect(messages.length).toBe(1)
  })

  it('allows island tokens in island contexts', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-island, 400)'; const overlay = 'var(--z-island-overlay, 390)'",
      '/repo/packages/ui/src/components/overlay/AnnotatableMarkdownDocument.tsx',
    )

    expect(messages.length).toBe(0)
  })

  it('flags floating menu token in IslandFollowUpContentView', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-floating-menu, 400)'",
      '/repo/packages/ui/src/components/ui/IslandFollowUpContentView.tsx',
    )

    expect(messages.length).toBe(1)
  })

  it('does not apply to non-island files', () => {
    const messages = runRule(
      "const zIndex = 'var(--z-floating-menu, 400)'",
      '/repo/packages/ui/src/components/markdown/TableExportDropdown.tsx',
    )

    expect(messages.length).toBe(0)
  })
})
