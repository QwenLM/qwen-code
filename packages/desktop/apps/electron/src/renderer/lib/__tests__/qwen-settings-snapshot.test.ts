import { describe, expect, it } from 'bun:test'
import type { QwenCoreSettingsSnapshot } from '@craft-agent/shared/protocol'
import { normalizeQwenSettingsSnapshot } from '../qwen-settings-snapshot'

describe('normalizeQwenSettingsSnapshot', () => {
  it('adds empty extension settings for older core settings snapshots', () => {
    const snapshot = {
      user: {
        path: '/Users/me/.qwen/settings.json',
        values: {},
        mcpServers: [],
        hooks: [],
      },
      workspace: {
        path: '/repo/.qwen/settings.json',
        values: {},
        mcpServers: [],
        hooks: [],
      },
      merged: {
        values: {},
        mcpServers: [],
        hooks: [],
      },
      workspaceTrusted: true,
    } as unknown as QwenCoreSettingsSnapshot

    expect(normalizeQwenSettingsSnapshot(snapshot)?.merged.extensions).toEqual(
      [],
    )
  })

  it('normalizes missing extension child arrays', () => {
    const snapshot = {
      user: {
        path: '',
        values: {},
        mcpServers: [],
        hooks: [],
      },
      workspace: {
        path: '',
        values: {},
        mcpServers: [],
        hooks: [],
      },
      merged: {
        values: {},
        mcpServers: [],
        hooks: [],
        extensions: [
          {
            id: 'extension-a',
            name: 'Extension A',
          },
        ],
      },
      workspaceTrusted: false,
    } as unknown as QwenCoreSettingsSnapshot

    expect(normalizeQwenSettingsSnapshot(snapshot)?.merged.extensions[0]).toEqual(
      {
        id: 'extension-a',
        name: 'Extension A',
        version: undefined,
        isActive: undefined,
        path: undefined,
        commands: [],
        skills: [],
        mcpServers: [],
        settings: [],
      },
    )
  })

  it('accepts the ACP shape with top-level extensions and isTrusted', () => {
    const snapshot = {
      user: {
        path: '',
        values: {},
        mcpServers: [],
        hooks: [],
      },
      workspace: {
        path: '',
        values: {},
        mcpServers: [],
        hooks: [],
      },
      merged: {
        values: {},
        mcpServers: [
          {
            name: 'open-computer-use',
            scope: 'extension',
            server: {
              transport: 'stdio',
              command: 'node',
              extensionName: 'computer-use-hybrid',
            },
          },
        ],
        hooks: [
          {
            event: 'PreToolUse',
            index: 0,
            scope: 'extension',
            hook: {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'node hook.js',
                },
              ],
            },
          },
        ],
      },
      extensions: [
        {
          id: 'computer-use-hybrid',
          name: 'computer-use-hybrid',
          isActive: true,
          commands: [],
          skills: [],
          mcpServers: ['open-computer-use'],
          settings: [],
        },
      ],
      isTrusted: true,
    } as unknown as QwenCoreSettingsSnapshot

    const normalized = normalizeQwenSettingsSnapshot(snapshot)

    expect(normalized?.workspaceTrusted).toBe(true)
    expect(normalized?.merged.extensions).toHaveLength(1)
    expect(normalized?.merged.extensions[0].mcpServers).toEqual([
      'open-computer-use',
    ])
    expect(normalized?.merged.mcpServers[0].scope).toBe('extension')
    expect(normalized?.merged.hooks[0].scope).toBe('extension')
  })
})
