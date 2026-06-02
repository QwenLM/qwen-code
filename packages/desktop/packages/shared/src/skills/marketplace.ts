export type SkillMarketplaceIconKey =
  | 'bailian-cli'
  | 'bailian-docs'
  | 'spark-video'

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
      id: 'bailian-cli',
      slug: 'bailian-cli',
      name: 'Bailian CLI',
      tagline: 'Use the Aliyun Model Studio CLI for AI generation tasks.',
      description:
        'Use Bailian CLI when you want Qwen Code to run Aliyun Model Studio CLI workflows for text, multimodal input, image generation and editing, video generation and editing, speech, file upload, app calls, knowledge retrieval, web search, and model listing.',
      iconKey: 'bailian-cli',
      websiteUrl:
        'https://github.com/modelstudioai/skills/tree/main/skills/bailian-cli',
      sourceUrl:
        'https://github.com/modelstudioai/skills/blob/main/skills/bailian-cli/SKILL.md',
      examples: [
        {
          title: 'Generate an image',
          prompt:
            'Use Bailian CLI to generate an image from this product concept.',
        },
        {
          title: 'Describe local media',
          prompt:
            'Use Bailian CLI to inspect this local video and summarize what happens.',
        },
        {
          title: 'Search model options',
          prompt:
            'Use Bailian CLI to list suitable models for a multimodal workflow.',
        },
      ],
    },
    {
      id: 'bailian-docs-llm-wiki',
      slug: 'bailian-docs-llm-wiki',
      name: 'Bailian Docs LLM Wiki',
      tagline: 'Look up Aliyun Bailian model and API documentation.',
      description:
        'Use Bailian Docs LLM Wiki when you want Qwen Code to answer Bailian platform questions from its model metadata, wiki pages, and raw documentation. It helps with model specs, API parameters, error codes, pricing, quotas, SDK usage, OpenAI-compatible interfaces, and multimodal capabilities.',
      iconKey: 'bailian-docs',
      websiteUrl:
        'https://github.com/modelstudioai/skills/tree/main/skills/bailian-docs-llm-wiki',
      sourceUrl:
        'https://github.com/modelstudioai/skills/blob/main/skills/bailian-docs-llm-wiki/SKILL.md',
      examples: [
        {
          title: 'Compare Bailian models',
          prompt:
            'Use Bailian Docs LLM Wiki to compare current Bailian text models for a long-context coding assistant.',
        },
        {
          title: 'Check API parameters',
          prompt:
            'Use Bailian Docs LLM Wiki to find the parameters for this Bailian API call.',
        },
        {
          title: 'Explain an error code',
          prompt:
            'Use Bailian Docs LLM Wiki to explain this Bailian error code and how to fix it.',
        },
      ],
    },
    {
      id: 'spark-video-episode',
      slug: 'spark-video-episode',
      name: 'Spark Video Episode',
      tagline: 'Run the Spark Video episode production pipeline.',
      description:
        'Use Spark Video Episode when you want Qwen Code to orchestrate the Spark Video pipeline end to end, from premise and script through storyboard, clip rendering, review, retries, and final stitching with user approval gates.',
      iconKey: 'spark-video',
      websiteUrl:
        'https://github.com/modelstudioai/skills/tree/main/skills/spark-video',
      sourceUrl:
        'https://github.com/modelstudioai/skills/blob/main/skills/spark-video/SKILL.md',
      examples: [
        {
          title: 'Make an episode',
          prompt:
            'Use Spark Video Episode to produce episode 001 for this project from the following premise.',
        },
        {
          title: 'Storyboard a short',
          prompt:
            'Use Spark Video Episode to turn this story idea into an approved storyboard before rendering.',
        },
        {
          title: 'Review rendered clips',
          prompt:
            'Use Spark Video Episode to review rendered shots and guide any rerenders before stitching.',
        },
      ],
    },
  ]

export function getSkillMarketplaceDefinition(
  skillId: string,
): SkillMarketplaceDefinition | undefined {
  return SKILL_MARKETPLACE_DEFINITIONS.find((skill) => skill.id === skillId)
}
