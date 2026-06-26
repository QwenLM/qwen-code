import { describe, expect, it } from 'bun:test'
import { normalizeQwenMemorySettings } from '../qwen-settings.ts'

describe('Qwen memory settings', () => {
  it('defaults missing memory settings', () => {
    expect(normalizeQwenMemorySettings(undefined)).toEqual({
      enableManagedAutoMemory: true,
      enableManagedAutoDream: false,
      enableAutoSkill: false,
      autoSkillConfirm: true,
    })
  })

  it('keeps boolean values and ignores non-boolean values', () => {
    expect(
      normalizeQwenMemorySettings({
        enableManagedAutoMemory: false,
        enableManagedAutoDream: 'yes',
        enableAutoSkill: true,
        autoSkillConfirm: false,
      }),
    ).toEqual({
      enableManagedAutoMemory: false,
      enableManagedAutoDream: false,
      enableAutoSkill: true,
      autoSkillConfirm: false,
    })
  })
})
