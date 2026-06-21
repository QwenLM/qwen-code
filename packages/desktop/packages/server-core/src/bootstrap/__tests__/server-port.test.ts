import { describe, expect, it } from 'bun:test'
import { parseServerPort } from '../headless-start'

describe('parseServerPort', () => {
  it('uses the default when the value is undefined', () => {
    expect(parseServerPort('CRAFT_RPC_PORT', undefined, 9100)).toBe(9100)
  })

  it('accepts whole decimal ports', () => {
    expect(parseServerPort('CRAFT_RPC_PORT', '0', 9100)).toBe(0)
    expect(parseServerPort('CRAFT_RPC_PORT', '9100', 0)).toBe(9100)
    expect(parseServerPort('CRAFT_RPC_PORT', '65535', 0)).toBe(65535)
    expect(parseServerPort('CRAFT_RPC_PORT', ' 3000 ', 0)).toBe(3000)
  })

  it('accepts integer numeric ports from bootstrap options', () => {
    expect(parseServerPort('rpcPort', 0, 9100)).toBe(0)
    expect(parseServerPort('rpcPort', 3000, 0)).toBe(3000)
  })

  it('rejects partially parsed port strings', () => {
    expect(() => parseServerPort('CRAFT_RPC_PORT', '9100abc', 9100)).toThrow(/Invalid CRAFT_RPC_PORT/)
    expect(() => parseServerPort('CRAFT_RPC_PORT', '3000.5', 9100)).toThrow(/Invalid CRAFT_RPC_PORT/)
    expect(() => parseServerPort('CRAFT_RPC_PORT', '1e3', 9100)).toThrow(/Invalid CRAFT_RPC_PORT/)
  })

  it('rejects out-of-range or non-integer ports', () => {
    expect(() => parseServerPort('CRAFT_RPC_PORT', '-1', 9100)).toThrow(/Invalid CRAFT_RPC_PORT/)
    expect(() => parseServerPort('CRAFT_RPC_PORT', '65536', 9100)).toThrow(/Invalid CRAFT_RPC_PORT/)
    expect(() => parseServerPort('rpcPort', 3000.5, 9100)).toThrow(/Invalid rpcPort/)
  })
})
