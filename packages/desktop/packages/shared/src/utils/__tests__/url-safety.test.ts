import { describe, it, expect } from 'bun:test'
import { classifyExternalUrl, isSafeExternalUrl } from '../url-safety.ts'

describe('classifyExternalUrl — safe external (standard web schemes)', () => {
  it('classifies http:// as safe-external', () => {
    expect(classifyExternalUrl('http://example.com').kind).toBe('safe-external')
  })

  it('classifies https:// as safe-external', () => {
    expect(classifyExternalUrl('https://example.com/path?q=1').kind).toBe('safe-external')
  })

  it('classifies mailto: as safe-external', () => {
    expect(classifyExternalUrl('mailto:user@example.com').kind).toBe('safe-external')
  })

  it('classifies tel: as safe-external', () => {
    expect(classifyExternalUrl('tel:+15551234567').kind).toBe('safe-external')
  })

  it('classifies sms: as safe-external', () => {
    expect(classifyExternalUrl('sms:+15551234567').kind).toBe('safe-external')
  })
})

describe('classifyExternalUrl — safe external (custom app schemes)', () => {
  it.each([
    ['obsidian://open?vault=mine&file=note'],
    ['vscode://file/Users/me/repo/src/index.ts'],
    ['zed://file/Users/me/repo/src/index.ts'],
    ['notion://open?id=abc123'],
    ['slack://channel?team=T1&id=C2'],
    ['things:///show?id=abc'],
    ['jetbrains://idea/navigate/reference?project=foo'],
    ['cursor://open?path=/tmp/x'],
    ['craftdocs://open?docId=123'],
  ])('classifies %s as safe-external', (url) => {
    expect(classifyExternalUrl(url).kind).toBe('safe-external')
  })
})

describe('classifyExternalUrl — internal deep links', () => {
  it('classifies craftagents:// as internal-deeplink', () => {
    expect(classifyExternalUrl('craftagents://settings').kind).toBe('internal-deeplink')
  })

  it('is case-insensitive for the scheme', () => {
    expect(classifyExternalUrl('CRAFTAGENTS://settings').kind).toBe('internal-deeplink')
  })
})

describe('classifyExternalUrl — dangerous schemes', () => {
  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['JAVASCRIPT:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox("hi")'],
    ['blob:https://example.com/abc'],
    ['file:///etc/passwd'],
    ['FILE:///etc/passwd'],
  ])('classifies %s as dangerous', (url) => {
    const result = classifyExternalUrl(url)
    expect(result.kind).toBe('dangerous')
    if (result.kind === 'dangerous') {
      expect(result.reason).toBeTruthy()
    }
  })
})

describe('classifyExternalUrl — malformed input', () => {
  it('rejects empty string', () => {
    const result = classifyExternalUrl('')
    expect(result.kind).toBe('dangerous')
  })

  it('rejects whitespace-only string', () => {
    const result = classifyExternalUrl('   ')
    expect(result.kind).toBe('dangerous')
  })

  it('rejects plain text that is not a URL', () => {
    const result = classifyExternalUrl('not a url')
    expect(result.kind).toBe('dangerous')
  })

  it('trims leading/trailing whitespace before classifying', () => {
    expect(classifyExternalUrl('  https://example.com  ').kind).toBe('safe-external')
  })
})

describe('isSafeExternalUrl', () => {
  it('returns true for http/https', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
  })

  it('returns true for custom app schemes', () => {
    expect(isSafeExternalUrl('obsidian://open?vault=mine')).toBe(true)
    expect(isSafeExternalUrl('vscode://file/x')).toBe(true)
  })

  it('returns false for internal deep links', () => {
    expect(isSafeExternalUrl('craftagents://settings')).toBe(false)
  })

  it('returns false for dangerous schemes', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(isSafeExternalUrl('')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})
