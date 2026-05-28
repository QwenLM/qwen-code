export type SkillMarketplaceIconKey = 'presentation'

export interface SkillMarketplaceExample {
  title: string
  prompt: string
}

export interface SkillMarketplaceDefinition {
  id: string
  slug: string
  name: string
  tagline: string
  description: string
  iconKey: SkillMarketplaceIconKey
  websiteUrl?: string
  sourceUrl: string
  examples: SkillMarketplaceExample[]
  heroImage?: string
}

export const SKILL_MARKETPLACE_DEFINITIONS: readonly SkillMarketplaceDefinition[] =
  [
    {
      id: 'pptx',
      slug: 'pptx',
      name: 'PPTX',
      tagline: 'Create, inspect, and edit PowerPoint slide decks.',
      description:
        'Use PPTX when you want Qwen Code to create, inspect, or revise PowerPoint decks. It can help draft presentation structure, generate slide content, update existing decks, and reason about slide assets while keeping presentation work in the flow of a normal coding session.',
      iconKey: 'presentation',
      websiteUrl: 'https://github.com/anthropics/skills/tree/main/skills/pptx',
      sourceUrl:
        'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
      examples: [
        {
          title: 'Create a pitch deck',
          prompt:
            'Create a 10-slide pitch deck for a new AI note-taking product.',
        },
        {
          title: 'Review a presentation',
          prompt:
            'Inspect this slide deck and suggest concrete improvements for structure, clarity, and visual hierarchy.',
        },
        {
          title: 'Turn notes into slides',
          prompt:
            'Turn these planning notes into a concise executive presentation.',
        },
      ],
    },
  ]

export function getSkillMarketplaceDefinition(
  skillId: string,
): SkillMarketplaceDefinition | undefined {
  return SKILL_MARKETPLACE_DEFINITIONS.find((skill) => skill.id === skillId)
}
