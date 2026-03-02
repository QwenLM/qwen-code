export interface InsightImpressiveWorkflows {
  intro: string;
  impressive_workflows: Array<{
    title: string;
    description: string;
  }>;
}

export interface InsightProjectAreas {
  areas: Array<{
    name: string;
    session_count: number;
    description: string;
  }>;
}

export interface InsightFutureOpportunities {
  intro: string;
  opportunities: Array<{
    title: string;
    whats_possible: string;
    how_to_try: string;
    copyable_prompt: string;
  }>;
}

export interface InsightFrictionPoints {
  intro: string;
  categories: Array<{
    category: string;
    description: string;
    examples: string[];
  }>;
}

export interface InsightMemorableMoment {
  headline: string;
  detail: string;
}

export interface InsightImprovements {
  Qwen_md_additions: Array<{
    addition: string;
    why: string;
    prompt_scaffold: string;
  }>;
  features_to_try: Array<{
    feature: string;
    one_liner: string;
    why_for_you: string;
    example_code: string;
  }>;
  usage_patterns: Array<{
    title: string;
    suggestion: string;
    detail: string;
    copyable_prompt: string;
  }>;
}

export interface InsightInteractionStyle {
  narrative: string;
  key_pattern: string;
}

export interface InsightAtAGlance {
  whats_working: string;
  whats_hindering: string;
  quick_wins: string;
  ambitious_workflows: string;
}

export interface QualitativeInsights {
  impressiveWorkflows: InsightImpressiveWorkflows;
  projectAreas: InsightProjectAreas;
  futureOpportunities: InsightFutureOpportunities;
  frictionPoints: InsightFrictionPoints;
  memorableMoment: InsightMemorableMoment;
  improvements: InsightImprovements;
  interactionStyle: InsightInteractionStyle;
  atAGlance: InsightAtAGlance;
}
