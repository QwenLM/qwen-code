import { describe, expect, it } from 'vitest'
import { shouldLoadWorkspaceSkills } from '../skills-loading'

describe('shouldLoadWorkspaceSkills', () => {
  it('loads skills for the skills navigator before connections hydrate', () => {
    expect(
      shouldLoadWorkspaceSkills({
        isSkillsNavigation: true,
        llmConnectionCount: 0,
      }),
    ).toBe(true)
  })

  it('loads Qwen skills in the background once connections are available', () => {
    expect(
      shouldLoadWorkspaceSkills({
        isSkillsNavigation: false,
        llmConnectionCount: 1,
        providerType: 'qwen',
      }),
    ).toBe(true)
  })

  it('waits when outside the skills navigator and connections are not loaded', () => {
    expect(
      shouldLoadWorkspaceSkills({
        isSkillsNavigation: false,
        llmConnectionCount: 0,
      }),
    ).toBe(false)
  })
})
