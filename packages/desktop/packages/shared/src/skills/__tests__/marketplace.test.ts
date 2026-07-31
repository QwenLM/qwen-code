import { describe, expect, it } from 'bun:test'
import {
  getSkillMarketplaceDefinition,
  SKILL_MARKETPLACE_DEFINITIONS,
} from '../marketplace.ts'

describe('skill marketplace definitions', () => {
  it('exposes the modelstudioai skills', () => {
    expect(SKILL_MARKETPLACE_DEFINITIONS.map((skill) => skill.id)).toEqual([
      'bailian-cli',
      'bailian-docs-llm-wiki',
      'spark-video-episode',
    ])
  })

  it('uses installable GitHub SKILL.md URLs for modelstudioai skills', () => {
    const modelstudioSkills = SKILL_MARKETPLACE_DEFINITIONS.filter((skill) =>
      skill.sourceUrl.includes('github.com/modelstudioai/skills/'),
    )

    expect(modelstudioSkills).toHaveLength(3)
    for (const skill of modelstudioSkills) {
      expect(skill.sourceUrl).toContain('/blob/main/skills/')
      expect(skill.sourceUrl).toEndWith('/SKILL.md')
      expect(skill.websiteUrl).toContain('/tree/main/skills/')
    }
    expect(modelstudioSkills.map((skill) => skill.iconKey)).toEqual([
      'bailian-cli',
      'bailian-docs',
      'spark-video',
    ])
  })

  it('looks up spark-video by the installable skill name', () => {
    const skill = getSkillMarketplaceDefinition('spark-video-episode')

    expect(skill?.slug).toBe('spark-video-episode')
    expect(skill?.sourceUrl).toBe(
      'https://github.com/modelstudioai/skills/blob/main/skills/spark-video/SKILL.md',
    )
  })
})
