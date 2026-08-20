import { describe, expect, it } from 'bun:test'
import { getHostname } from '../utils'

describe('getHostname', () => {
  it('returns stripped hostname for https URLs', () => {
    expect(getHostname('https://www.example.com/path?q=1')).toBe('example.com')
  })

  it('returns New Tab for about:blank', () => {
    expect(getHostname('about:blank')).toBe('New Tab')
  })

  it('returns filename for file URLs', () => {
    expect(getHostname('file:///Users/tester/report.html')).toBe('report.html')
  })

  it('returns Local File for file URLs without basename', () => {
    expect(getHostname('file:///Users/tester/folder/')).toBe('Local File')
  })

  it('returns protocol token for custom schemes with empty hostname', () => {
    expect(getHostname('data:text/html,hello')).toBe('data')
  })

  it('falls back to original input for malformed URLs', () => {
    expect(getHostname('not a url')).toBe('not a url')
  })
})
