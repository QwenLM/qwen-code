import { describe, expect, it } from 'bun:test'
import { escapeAnsiCtrlCodes } from './ansi'

describe('escapeAnsiCtrlCodes', () => {
  it('escapes CSI and OSC control sequences', () => {
    expect(escapeAnsiCtrlCodes('\x1b[31mred')).toBe('\\u001b[31mred')
    expect(escapeAnsiCtrlCodes('\x1b]0;title\x07text')).toBe(
      '\\u001b]0;title\\u0007text',
    )
  })

  it('passes plain text through and remains stable across repeated calls', () => {
    expect(escapeAnsiCtrlCodes('plain text')).toBe('plain text')
    expect(escapeAnsiCtrlCodes('\x1b[32mgreen')).toBe('\\u001b[32mgreen')
    expect(escapeAnsiCtrlCodes('\x1b[33myellow')).toBe('\\u001b[33myellow')
  })
})
