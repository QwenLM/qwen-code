import { describe, expect, it } from 'bun:test'
import { resolveStatusIconSource } from '../status-icon'

describe('resolveStatusIconSource', () => {
  it('treats bare icon filenames as local overrides in statuses/icons', () => {
    expect(resolveStatusIconSource('todo', 'in-progress.svg')).toEqual({
      iconPath: 'statuses/icons/in-progress.svg',
    })
  })

  it('treats .webp filenames as local overrides', () => {
    expect(resolveStatusIconSource('todo', 'custom-icon.webp')).toEqual({
      iconPath: 'statuses/icons/custom-icon.webp',
    })
  })

  it('rejects nested paths from being treated as local overrides', () => {
    expect(resolveStatusIconSource('todo', '../in-progress.svg')).toEqual({
      iconValue: '../in-progress.svg',
      iconFileName: 'todo',
    })
  })

  it('preserves emoji and url icon values', () => {
    expect(resolveStatusIconSource('todo', '✅')).toEqual({
      iconValue: '✅',
      iconFileName: 'todo',
    })

    expect(resolveStatusIconSource('todo', 'https://example.com/icon.svg')).toEqual({
      iconValue: 'https://example.com/icon.svg',
      iconFileName: 'todo',
    })
  })
})
