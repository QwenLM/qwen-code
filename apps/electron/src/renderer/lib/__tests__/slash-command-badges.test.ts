import { describe, expect, it } from 'bun:test'

import { extractCommandBadges, findSlashCommandMatches } from '../slash-command-badges'

describe('findSlashCommandMatches', () => {
  it('matches known slash commands after start or whitespace', () => {
    expect(findSlashCommandMatches('/status ', ['status'])).toEqual([
      { type: 'command', id: 'status', fullMatch: '/status', startIndex: 0 },
    ])
    expect(findSlashCommandMatches('run /compress now', ['compress'])).toEqual([
      { type: 'command', id: 'compress', fullMatch: '/compress', startIndex: 4 },
    ])
  })

  it('does not match unknown commands when command names are provided', () => {
    expect(findSlashCommandMatches('/unknown ', ['status'])).toEqual([])
  })

  it('hides unsupported Qwen commands', () => {
    expect(findSlashCommandMatches('/model ', ['model'])).toEqual([])
    expect(findSlashCommandMatches('/skills ', ['skills'])).toEqual([])
  })
})

describe('extractCommandBadges', () => {
  it('creates command badges without changing command text', () => {
    expect(extractCommandBadges('/status show details')).toEqual([
      {
        type: 'command',
        label: '/status',
        rawText: '/status',
        start: 0,
        end: 7,
      },
    ])
  })
})
