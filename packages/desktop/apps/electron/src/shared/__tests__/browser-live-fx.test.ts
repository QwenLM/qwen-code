import { describe, expect, it } from 'bun:test'

import { getBrowserLiveFxCornerRadii } from '../browser-live-fx'

describe('getBrowserLiveFxCornerRadii', () => {
  it('uses 16px bottom corners on macOS', () => {
    expect(getBrowserLiveFxCornerRadii('darwin')).toEqual({
      topLeft: '0px',
      topRight: '0px',
      bottomLeft: '16px',
      bottomRight: '16px',
    })
  })

  it('uses 8px bottom corners on Windows', () => {
    expect(getBrowserLiveFxCornerRadii('win32')).toEqual({
      topLeft: '0px',
      topRight: '0px',
      bottomLeft: '8px',
      bottomRight: '8px',
    })
  })

  it('uses 6px bottom corners on Linux and fallback platforms', () => {
    expect(getBrowserLiveFxCornerRadii('linux')).toEqual({
      topLeft: '0px',
      topRight: '0px',
      bottomLeft: '6px',
      bottomRight: '6px',
    })

    expect(getBrowserLiveFxCornerRadii('other')).toEqual({
      topLeft: '0px',
      topRight: '0px',
      bottomLeft: '6px',
      bottomRight: '6px',
    })
  })
})
