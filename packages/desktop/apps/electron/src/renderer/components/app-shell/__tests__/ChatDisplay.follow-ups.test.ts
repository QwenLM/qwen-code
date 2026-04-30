import { describe, test, expect } from 'bun:test'
import {
  formatFollowUpSection,
  normalizeFollowUpsMarkdown,
  truncateForChipTooltip,
  type PendingFollowUpAnnotation,
} from '../ChatDisplay.follow-ups'

function followUp(overrides: Partial<PendingFollowUpAnnotation> = {}): PendingFollowUpAnnotation {
  return {
    messageId: 'msg1',
    annotationId: 'ann1',
    note: 'keep only this',
    selectedText: 'the quick brown fox',
    createdAt: 0,
    ...overrides,
  }
}

describe('formatFollowUpSection — the OSS #580 regression', () => {
  test('preserves a >1000-char quote verbatim (no truncation to 280)', () => {
    const longQuote = 'a'.repeat(1200)
    const output = formatFollowUpSection([followUp({ selectedText: longQuote })])
    expect(output).toContain(longQuote)
    expect(output).not.toContain('…')
    // Length proves the full quote is in the message, not truncated at 280.
    expect(output.length).toBeGreaterThan(1200)
  })

  test('collapses multiline quotes to a single line (required by round-trip parser)', () => {
    const multiline = 'first paragraph\n\nsecond paragraph\n\n\nthird paragraph'
    const output = formatFollowUpSection([followUp({ selectedText: multiline })])
    expect(output).toContain('first paragraph second paragraph third paragraph')
  })

  test('emits the canonical `> [#N] <quote>\\n→ <note>` shape for a single follow-up', () => {
    const output = formatFollowUpSection([followUp({ selectedText: 'hello', note: 'make it bold' })])
    expect(output).toContain('> [#1] hello')
    expect(output).toContain('→ make it bold')
    expect(output).toContain('**Follow-ups**')
  })

  test('numbers multiple follow-ups sequentially', () => {
    const output = formatFollowUpSection([
      followUp({ annotationId: 'a', selectedText: 'one', note: 'n1' }),
      followUp({ annotationId: 'b', selectedText: 'two', note: 'n2' }),
      followUp({ annotationId: 'c', selectedText: 'three', note: 'n3' }),
    ])
    expect(output).toContain('[#1] one')
    expect(output).toContain('[#2] two')
    expect(output).toContain('[#3] three')
  })

  test('returns an empty string when no follow-ups are pending', () => {
    expect(formatFollowUpSection([])).toBe('')
  })

  test('respects includeTopSeparator=false (used when there is no base message)', () => {
    const output = formatFollowUpSection([followUp()], { includeTopSeparator: false })
    expect(output.startsWith('**Follow-ups**')).toBe(true)
  })

  test('prepends a `---` separator by default (used under a base message)', () => {
    const output = formatFollowUpSection([followUp()])
    expect(output.startsWith('---\n\n**Follow-ups**')).toBe(true)
  })
})

describe('normalizeFollowUpsMarkdown — round-trip parser', () => {
  test('round-trips a long-quote message unchanged', () => {
    const longQuote = 'b'.repeat(800)
    const section = formatFollowUpSection([followUp({ selectedText: longQuote, note: 'keep' })])
    const full = `hello agent\n\n${section}`
    expect(normalizeFollowUpsMarkdown(full)).toBe(full)
  })

  test('renumbers items when called on a message with wrong indices', () => {
    const garbled = [
      'hello',
      '',
      '---',
      '',
      '**Follow-ups**',
      '',
      '> [#5] quote A',
      '→ note A',
      '',
      '---',
      '',
      '> [#9] quote B',
      '→ note B',
    ].join('\n')
    const output = normalizeFollowUpsMarkdown(garbled)
    expect(output).toContain('[#1] quote A')
    expect(output).toContain('[#2] quote B')
    expect(output).not.toContain('[#5]')
    expect(output).not.toContain('[#9]')
  })

  test('returns the input unchanged if no follow-up heading is present', () => {
    const plain = 'just a regular message with no follow-ups'
    expect(normalizeFollowUpsMarkdown(plain)).toBe(plain)
  })
})

describe('truncateForChipTooltip', () => {
  test('returns input unchanged when below the cap', () => {
    expect(truncateForChipTooltip('short', 100)).toBe('short')
  })

  test('truncates with ellipsis when over the cap', () => {
    const input = 'x'.repeat(300)
    const out = truncateForChipTooltip(input, 100)
    expect(out.length).toBe(100)
    expect(out.endsWith('…')).toBe(true)
  })

  test('collapses whitespace before measuring length', () => {
    const input = '  spaced\n\nout    words  '
    expect(truncateForChipTooltip(input, 100)).toBe('spaced out words')
  })
})
