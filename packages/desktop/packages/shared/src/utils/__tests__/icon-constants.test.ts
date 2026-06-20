import { describe, expect, it } from 'bun:test'

import { isIconUrl } from '../icon-constants.ts'
import { validateIconValue } from '../icon.ts'

describe('icon URL detection', () => {
  it('treats http and https schemes as case-insensitive', () => {
    expect(isIconUrl('HTTP://cdn.example.com/icon.svg')).toBe(true)
    expect(isIconUrl('HTTPS://cdn.example.com/icon.svg')).toBe(true)
    expect(validateIconValue('HTTPS://cdn.example.com/icon.svg')).toBe(
      'HTTPS://cdn.example.com/icon.svg',
    )
  })

  it('rejects non-http icon URLs', () => {
    expect(isIconUrl('ftp://cdn.example.com/icon.svg')).toBe(false)
    expect(isIconUrl('data:image/svg+xml;base64,abc')).toBe(false)
  })
})
