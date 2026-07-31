import { describe, it, expect } from 'bun:test'
import { parseAutomationsConfig } from '../types'

describe('parseAutomationsConfig', () => {
  it('returns [] for null input', () => {
    expect(parseAutomationsConfig(null)).toEqual([])
  })

  it('returns [] for undefined input', () => {
    expect(parseAutomationsConfig(undefined)).toEqual([])
  })

  it('returns [] for non-object input', () => {
    expect(parseAutomationsConfig('string')).toEqual([])
    expect(parseAutomationsConfig(42)).toEqual([])
    expect(parseAutomationsConfig(true)).toEqual([])
  })

  it('returns [] for { automations: {} } (empty automations)', () => {
    expect(parseAutomationsConfig({ version: 2, automations: {} })).toEqual([])
  })

  it('returns [] for missing automations key', () => {
    expect(parseAutomationsConfig({ version: 2 })).toEqual([])
  })

  it('parses single event with one matcher', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [{
          cron: '0 9 * * 1-5',
          actions: [{ type: 'prompt', prompt: 'echo hello' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items).toHaveLength(1)
    expect(items[0].event).toBe('SchedulerTick')
    expect(items[0].matcherIndex).toBe(0)
    expect(items[0].cron).toBe('0 9 * * 1-5')
    expect(items[0].actions).toHaveLength(1)
    expect(items[0].actions[0].type).toBe('prompt')
  })

  it('parses multiple events with multiple matchers', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [
          { cron: '0 9 * * *', actions: [{ type: 'prompt', prompt: 'Run backup' }] },
          { cron: '0 18 * * *', actions: [{ type: 'prompt', prompt: 'Run cleanup' }] },
        ],
        LabelAdd: [
          { matcher: 'urgent', actions: [{ type: 'prompt', prompt: 'Handle urgent' }] },
        ],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items).toHaveLength(3)
    expect(items[0].event).toBe('SchedulerTick')
    expect(items[0].matcherIndex).toBe(0)
    expect(items[1].event).toBe('SchedulerTick')
    expect(items[1].matcherIndex).toBe(1)
    expect(items[2].event).toBe('LabelAdd')
    expect(items[2].matcherIndex).toBe(0)
  })

  it('derives name from name field when present', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [{
          name: 'Morning Backup',
          actions: [{ type: 'prompt', prompt: 'Run the morning backup' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('Morning Backup')
  })

  it('derives name from @mention in prompt', () => {
    const config = {
      version: 2,
      automations: {
        UserPromptSubmit: [{
          actions: [{ type: 'prompt', prompt: 'Run @daily-standup task' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('daily-standup prompt')
  })

  it('derives name from prompt when no name field', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          actions: [{ type: 'prompt', prompt: 'echo "hello world"' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('echo "hello world"')
  })

  it('truncates long names to 40 chars with ellipsis', () => {
    const longPrompt = 'a'.repeat(50)
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          actions: [{ type: 'prompt', prompt: longPrompt }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('a'.repeat(40) + '...')
  })

  it('sets enabled: true when field is missing (default)', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          actions: [{ type: 'prompt', prompt: 'Run test' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].enabled).toBe(true)
  })

  it('sets enabled: false when explicitly set', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          enabled: false,
          actions: [{ type: 'prompt', prompt: 'Run test' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].enabled).toBe(false)
  })

  it('skips matchers with empty actions array', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [
          { actions: [] },
          { actions: [{ type: 'prompt', prompt: 'valid' }] },
        ],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('valid')
  })

  it('generates correct matcherIndex per event', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [
          { actions: [{ type: 'prompt', prompt: 'a' }] },
          { actions: [{ type: 'prompt', prompt: 'b' }] },
          { actions: [{ type: 'prompt', prompt: 'c' }] },
        ],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].matcherIndex).toBe(0)
    expect(items[1].matcherIndex).toBe(1)
    expect(items[2].matcherIndex).toBe(2)
  })

  it('generates unique IDs across events', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [{ actions: [{ type: 'prompt', prompt: 'a' }] }],
        LabelAdd: [{ actions: [{ type: 'prompt', prompt: 'b' }] }],
        SessionStart: [{ actions: [{ type: 'prompt', prompt: 'c' }] }],
      },
    }
    const items = parseAutomationsConfig(config)
    const ids = items.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('preserves optional fields (matcher, cron, timezone, permissionMode, labels)', () => {
    const config = {
      version: 2,
      automations: {
        LabelAdd: [{
          matcher: 'urgent',
          permissionMode: 'ask',
          labels: ['important'],
          actions: [{ type: 'prompt', prompt: 'Handle it' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].matcher).toBe('urgent')
    expect(items[0].permissionMode).toBe('ask')
    expect(items[0].labels).toEqual(['important'])
  })
})
