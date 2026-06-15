import { describe, expect, it } from 'bun:test'

import {
  getMacAppBundlePath,
  parseMacCodeSignatureStatus,
} from '../auto-update-signature'

describe('auto-update-signature', () => {
  it('maps an executable path back to the macOS app bundle', () => {
    expect(getMacAppBundlePath('/Applications/OpenWork.app/Contents/MacOS/OpenWork'))
      .toBe('/Applications/OpenWork.app')
  })

  it('rejects ad-hoc signatures because they pin updates to a cdhash', () => {
    const status = parseMacCodeSignatureStatus('/Applications/OpenWork.app', 0, [
      'Signature=adhoc',
      'TeamIdentifier=not set',
    ].join('\n'))

    expect(status.trustedForAutoUpdate).toBe(false)
    expect(status.reason).toBe('adhoc-signature')
  })

  it('rejects unsigned apps', () => {
    const status = parseMacCodeSignatureStatus(
      '/Applications/OpenWork.app',
      1,
      '/Applications/OpenWork.app: code object is not signed at all',
    )

    expect(status.trustedForAutoUpdate).toBe(false)
    expect(status.reason).toBe('codesign-failed')
  })

  it('accepts signed apps with a TeamIdentifier', () => {
    const status = parseMacCodeSignatureStatus('/Applications/OpenWork.app', 0, [
      'Authority=Developer ID Application: Example Inc (ABCDE12345)',
      'TeamIdentifier=ABCDE12345',
    ].join('\n'))

    expect(status.trustedForAutoUpdate).toBe(true)
    expect(status.teamIdentifier).toBe('ABCDE12345')
  })
})
