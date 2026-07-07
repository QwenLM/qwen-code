import { describe, expect, it } from 'bun:test'
import {
  createConfigFromConnection,
  resolveModelForProvider,
} from '../factory'
import type { LlmConnection } from '../../../config/storage'

function makeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'qwen-code',
    name: 'Qwen Code',
    providerType: 'qwen',
    authType: 'none',
    createdAt: 1,
    ...overrides,
  }
}

describe('backend model resolution', () => {
  it('lets provider-managed Qwen sessions resolve without a fallback model', () => {
    expect(resolveModelForProvider('qwen', undefined, makeConnection())).toBe('')
  })

  it('keeps explicit managed model values', () => {
    expect(resolveModelForProvider('qwen', 'mimo-v2.5-pro', makeConnection())).toBe('mimo-v2.5-pro')
  })

  it('does not inject DEFAULT_MODEL into connection configs', () => {
    const config = createConfigFromConnection(makeConnection(), {
      workspace: {
        id: 'ws',
        name: 'Workspace',
        slug: 'workspace',
        rootPath: '/tmp/ws',
        createdAt: 1,
      },
    })

    expect(config.model).toBeUndefined()
  })
})
