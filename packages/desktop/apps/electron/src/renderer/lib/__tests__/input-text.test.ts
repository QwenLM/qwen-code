import { describe, expect, it } from 'bun:test'
import { coerceInputText } from '../input-text'

describe('coerceInputText', () => {
  it('preserves plain strings', () => {
    expect(coerceInputText('hello')).toBe('hello')
  })

  it('treats nullish values as empty text', () => {
    expect(coerceInputText(undefined)).toBe('')
    expect(coerceInputText(null)).toBe('')
  })

  it('extracts text from draft-like objects', () => {
    expect(coerceInputText({ text: 'draft text', attachments: [] })).toBe('draft text')
  })

  it('drops malformed object values instead of returning [object Object]', () => {
    expect(coerceInputText({ text: { nested: true } })).toBe('')
    expect(coerceInputText({ value: 'not a supported shape' })).toBe('')
  })

  it('stringifies primitive scalar values', () => {
    expect(coerceInputText(42)).toBe('42')
    expect(coerceInputText(false)).toBe('false')
  })
})
