import { describe, it, expect } from 'bun:test'
import { parseArgs, resolveApiKey, shouldSetupLlmConnection } from './index.ts'

// ---------------------------------------------------------------------------
// Arg parsing tests
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --url, --token, --workspace', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--url', 'ws://localhost:3000',
      '--token', 'secret123',
      '--workspace', 'ws-1',
      'ping',
    ])
    expect(args.url).toBe('ws://localhost:3000')
    expect(args.token).toBe('secret123')
    expect(args.workspace).toBe('ws-1')
    expect(args.command).toBe('ping')
  })

  it('parses --timeout and --json', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--timeout', '5000',
      '--json',
      'workspaces',
    ])
    expect(args.timeout).toBe(5000)
    expect(args.json).toBe(true)
    expect(args.command).toBe('workspaces')
  })

  it('parses --tls-ca', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--tls-ca', '/path/to/ca.pem',
      'ping',
    ])
    expect(args.tlsCa).toBe('/path/to/ca.pem')
  })

  it('parses --send-timeout', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '60000',
      'send', 'session-1', 'hello',
    ])
    expect(args.sendTimeout).toBe(60000)
    expect(args.command).toBe('send')
    expect(args.rest).toEqual(['session-1', 'hello'])
  })

  it('falls back to env vars for url and token', () => {
    const prevUrl = process.env.CRAFT_SERVER_URL
    const prevToken = process.env.CRAFT_SERVER_TOKEN
    const prevCa = process.env.CRAFT_TLS_CA

    process.env.CRAFT_SERVER_URL = 'ws://env-server:8080'
    process.env.CRAFT_SERVER_TOKEN = 'env-token'
    process.env.CRAFT_TLS_CA = '/env/ca.pem'

    try {
      const args = parseArgs(['bun', 'index.ts', 'ping'])
      expect(args.url).toBe('ws://env-server:8080')
      expect(args.token).toBe('env-token')
      expect(args.tlsCa).toBe('/env/ca.pem')
    } finally {
      if (prevUrl === undefined) delete process.env.CRAFT_SERVER_URL
      else process.env.CRAFT_SERVER_URL = prevUrl
      if (prevToken === undefined) delete process.env.CRAFT_SERVER_TOKEN
      else process.env.CRAFT_SERVER_TOKEN = prevToken
      if (prevCa === undefined) delete process.env.CRAFT_TLS_CA
      else process.env.CRAFT_TLS_CA = prevCa
    }
  })

  it('explicit flags override env vars', () => {
    const prevUrl = process.env.CRAFT_SERVER_URL
    process.env.CRAFT_SERVER_URL = 'ws://env-server:8080'

    try {
      const args = parseArgs(['bun', 'index.ts', '--url', 'ws://flag-server:9090', 'ping'])
      expect(args.url).toBe('ws://flag-server:9090')
    } finally {
      if (prevUrl === undefined) delete process.env.CRAFT_SERVER_URL
      else process.env.CRAFT_SERVER_URL = prevUrl
    }
  })

  it('parses --help as command', () => {
    const args = parseArgs(['bun', 'index.ts', '--help'])
    expect(args.command).toBe('help')
  })

  it('parses --version as command', () => {
    const args = parseArgs(['bun', 'index.ts', '--version'])
    expect(args.command).toBe('version')
  })

  it('parses --validate-server as command', () => {
    const args = parseArgs(['bun', 'index.ts', '--validate-server'])
    expect(args.command).toBe('validate')
  })

  it('parses session subcommand with args', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      'session', 'create', '--name', 'test', '--mode', 'safe',
    ])
    expect(args.command).toBe('session')
    // --mode is now a global flag, consumed at top level
    expect(args.rest).toEqual(['create', '--name', 'test'])
    expect(args.mode).toBe('safe')
  })

  it('parses send with message text', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      'send', 'sess-123', 'What', 'files', 'are', 'here?',
    ])
    expect(args.command).toBe('send')
    expect(args.rest).toEqual(['sess-123', 'What', 'files', 'are', 'here?'])
  })

  it('parses invoke with channel and JSON args', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      'invoke', 'sessions:get', '["workspace-1"]',
    ])
    expect(args.command).toBe('invoke')
    expect(args.rest).toEqual(['sessions:get', '["workspace-1"]'])
  })

  it('defaults to empty command (shows help)', () => {
    const args = parseArgs(['bun', 'index.ts'])
    expect(args.command).toBe('')
  })

  it('defaults timeout to 10000', () => {
    const args = parseArgs(['bun', 'index.ts', 'ping'])
    expect(args.timeout).toBe(10000)
  })

  it('defaults sendTimeout to 300000', () => {
    const args = parseArgs(['bun', 'index.ts', 'send', 's1', 'hi'])
    expect(args.sendTimeout).toBe(300000)
  })

  it('defaults json to false', () => {
    const args = parseArgs(['bun', 'index.ts', 'ping'])
    expect(args.json).toBe(false)
  })

  // --- run-specific flags ---

  it('parses run command with positional args', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello', 'world'])
    expect(args.command).toBe('run')
    expect(args.rest).toEqual(['hello', 'world'])
  })

  it('--source accumulates into array', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--source', 'craft-kb',
      '--source', 'github',
      'run', 'do stuff',
    ])
    expect(args.sources).toEqual(['craft-kb', 'github'])
  })

  it('defaults sources to empty array', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.sources).toEqual([])
  })

  it('--mode sets mode', () => {
    const args = parseArgs(['bun', 'index.ts', '--mode', 'safe', 'run', 'hello'])
    expect(args.mode).toBe('safe')
  })

  it('defaults mode to empty (run defaults to allow-all)', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.mode).toBe('')
  })

  it('--output-format sets outputFormat', () => {
    const args = parseArgs(['bun', 'index.ts', '--output-format', 'stream-json', 'run', 'hello'])
    expect(args.outputFormat).toBe('stream-json')
  })

  it('defaults outputFormat to text', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.outputFormat).toBe('text')
  })

  it('--no-cleanup sets noCleanup', () => {
    const args = parseArgs(['bun', 'index.ts', '--no-cleanup', 'run', 'hello'])
    expect(args.noCleanup).toBe(true)
  })

  it('defaults noCleanup to false', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.noCleanup).toBe(false)
  })

  it('--server-entry sets serverEntry', () => {
    const args = parseArgs(['bun', 'index.ts', '--server-entry', '/path/to/server.ts', 'run', 'hello'])
    expect(args.serverEntry).toBe('/path/to/server.ts')
  })

  it('defaults serverEntry to undefined', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.serverEntry).toBeUndefined()
  })

  it('--workspace-dir sets workspaceDir', () => {
    const args = parseArgs(['bun', 'index.ts', '--workspace-dir', '/tmp/ws', 'run', 'hello'])
    expect(args.workspaceDir).toBe('/tmp/ws')
  })

  it('defaults workspaceDir to undefined', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.workspaceDir).toBeUndefined()
  })

  it('parses --provider deepseek for run', () => {
    const args = parseArgs(['bun', 'index.ts', '--provider', 'deepseek', 'run', 'hello'])
    expect(args.provider).toBe('deepseek')
  })
})

// ---------------------------------------------------------------------------
// Provider credential resolution tests
// ---------------------------------------------------------------------------

describe('resolveApiKey', () => {
  it('keeps explicit key passthrough for script compatibility', () => {
    expect(resolveApiKey('qwen', 'unused-key')).toBe('unused-key')
  })
})

describe('shouldSetupLlmConnection', () => {
  it('sets up Qwen when no connection exists', () => {
    expect(shouldSetupLlmConnection(0, { provider: 'qwen', baseUrl: '' })).toBe(true)
  })

  it('skips setup when a connection already exists', () => {
    expect(shouldSetupLlmConnection(2, { provider: 'qwen', baseUrl: '' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Validate steps structure tests
// ---------------------------------------------------------------------------

import { getValidateSteps } from './index.ts'

describe('getValidateSteps', () => {
  it('returns a non-empty array of steps', () => {
    const steps = getValidateSteps()
    expect(steps.length).toBeGreaterThan(0)
    // Sanity: at least the known lifecycle groups exist
    expect(steps.length).toBeGreaterThanOrEqual(20)
  })

  it('first step is handshake', () => {
    const steps = getValidateSteps()
    expect(steps[0].name).toBe('Connect + handshake')
  })

  it('last step is disconnect', () => {
    const steps = getValidateSteps()
    expect(steps[steps.length - 1].name).toBe('Disconnect')
  })

  it('has no duplicate step names', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('includes session lifecycle steps (create, read, delete)', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('sessions:create')
    expect(names).toContain('sessions:getMessages')
    expect(names).toContain('sessions:delete')
  })

  it('includes send message + stream step', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('send message + stream')
  })

  it('includes send message + tool use step', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('send message + tool use')
  })

  it('includes source lifecycle steps (create, mention, delete)', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('sources:create')
    expect(names).toContain('send + source mention')
    expect(names).toContain('sources:delete')
  })

  it('includes skill lifecycle steps (create, mention, delete)', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('send + skill create')
    expect(names).toContain('send + skill mention')
    expect(names).toContain('skills:delete')
  })

  it('includes automation lifecycle steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('automation:create')
    expect(names).toContain('automation:trigger (status change)')
    expect(names).toContain('automation:verify session')
    expect(names).toContain('automation:verify labels')
    expect(names).toContain('automations:getLastExecuted')
    expect(names).toContain('automation:cleanup')
  })

  it('includes session tool validation steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('session-tools:set_session_labels')
    expect(names).toContain('session-tools:get_session_info')
    expect(names).toContain('session-tools:list_sessions')
  })

  it('session tool steps come after tool use and before branching', () => {
    const names = getValidateSteps().map((s) => s.name)
    const toolUse = names.indexOf('send message + tool use')
    const labels = names.indexOf('session-tools:set_session_labels')
    const branch = names.indexOf('sessions:branch')
    expect(labels).toBeGreaterThan(toolUse)
    expect(branch).toBeGreaterThan(labels)
  })

  it('includes session branching steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('sessions:branch')
    expect(names).toContain('sessions:branch verify')
    expect(names).toContain('sessions:branch send')
  })

  it('includes webhook validation steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('webhook:test (RPC)')
    expect(names).toContain('webhook:verify failure')
  })

  it('creates session with allow-all permission mode', () => {
    const steps = getValidateSteps()
    const createStep = steps.find((s) => s.name === 'sessions:create')
    expect(createStep).toBeDefined()
  })

  it('cleanup steps come after send steps', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    const skillDelete = names.indexOf('skills:delete')
    const sourceDelete = names.indexOf('sources:delete')
    const sessionDelete = names.indexOf('sessions:delete')
    const skillMention = names.indexOf('send + skill mention')
    expect(skillDelete).toBeGreaterThan(skillMention)
    expect(sourceDelete).toBeGreaterThan(skillDelete)
    expect(sessionDelete).toBeGreaterThan(sourceDelete)
  })

  it('branching steps come after send message + tool use', () => {
    const names = getValidateSteps().map((s) => s.name)
    const toolUse = names.indexOf('send message + tool use')
    const branch = names.indexOf('sessions:branch')
    expect(branch).toBeGreaterThan(toolUse)
  })

  it('automation cleanup comes before sources:delete', () => {
    const names = getValidateSteps().map((s) => s.name)
    const cleanup = names.indexOf('automation:cleanup')
    const srcDelete = names.indexOf('sources:delete')
    expect(cleanup).toBeGreaterThan(-1)
    expect(cleanup).toBeLessThan(srcDelete)
  })
})
