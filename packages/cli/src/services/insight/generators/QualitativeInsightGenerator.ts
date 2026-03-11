/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger, getInsightPrompt } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import pLimit from 'p-limit';
import type {
  InsightData,
  SessionFacets,
} from '../types/StaticInsightTypes.js';
import type {
  QualitativeInsights,
  InsightImpressiveWorkflows,
  InsightProjectAreas,
  InsightFutureOpportunities,
  InsightFrictionPoints,
  InsightMemorableMoment,
  InsightImprovements,
  InsightInteractionStyle,
  InsightAtAGlance,
} from '../types/QualitativeInsightTypes.js';

const logger = createDebugLogger('QualitativeInsightGenerator');

const CONCURRENCY_LIMIT = 4;

/**
 * Generates qualitative (LLM-produced) insight sections by running
 * multiple concurrent LLM calls with different prompt templates.
 */
export class QualitativeInsightGenerator {
  constructor(private config: Config) {}

  async generate(
    metrics: Omit<InsightData, 'facets' | 'qualitative'>,
    facets: SessionFacets[],
  ): Promise<QualitativeInsights | undefined> {
    if (facets.length === 0) {
      return undefined;
    }

    logger.info('Generating qualitative insights...');

    const commonData = this.prepareCommonPromptData(metrics, facets);

    const generateJson = async <T>(
      promptTemplate: string,
      schema: Record<string, unknown>,
    ): Promise<T> => {
      const prompt = `${promptTemplate}\n\n${commonData}`;
      try {
        const result = await this.config.getBaseLlmClient().generateJson({
          model: this.config.getModel(),
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          schema,
          abortSignal: AbortSignal.timeout(600000),
        });
        return result as T;
      } catch (error) {
        logger.error('Failed to generate insight:', error);
        throw error;
      }
    };

    // Schemas for each insight type
    const schemaImpressiveWorkflows = {
      type: 'object',
      properties: {
        intro: { type: 'string' },
        impressive_workflows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['title', 'description'],
          },
        },
      },
      required: ['intro', 'impressive_workflows'],
    };

    const schemaProjectAreas = {
      type: 'object',
      properties: {
        areas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              session_count: { type: 'number' },
              description: { type: 'string' },
            },
            required: ['name', 'session_count', 'description'],
          },
        },
      },
      required: ['areas'],
    };

    const schemaFutureOpportunities = {
      type: 'object',
      properties: {
        intro: { type: 'string' },
        opportunities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              whats_possible: { type: 'string' },
              how_to_try: { type: 'string' },
              copyable_prompt: { type: 'string' },
            },
            required: [
              'title',
              'whats_possible',
              'how_to_try',
              'copyable_prompt',
            ],
          },
        },
      },
      required: ['intro', 'opportunities'],
    };

    const schemaFrictionPoints = {
      type: 'object',
      properties: {
        intro: { type: 'string' },
        categories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              description: { type: 'string' },
              examples: { type: 'array', items: { type: 'string' } },
            },
            required: ['category', 'description', 'examples'],
          },
        },
      },
      required: ['intro', 'categories'],
    };

    const schemaMemorableMoment = {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['headline', 'detail'],
    };

    const schemaImprovements = {
      type: 'object',
      properties: {
        Qwen_md_additions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              addition: { type: 'string' },
              why: { type: 'string' },
              prompt_scaffold: { type: 'string' },
            },
            required: ['addition', 'why', 'prompt_scaffold'],
          },
        },
        features_to_try: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              feature: { type: 'string' },
              one_liner: { type: 'string' },
              why_for_you: { type: 'string' },
              example_code: { type: 'string' },
            },
            required: ['feature', 'one_liner', 'why_for_you', 'example_code'],
          },
        },
        usage_patterns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              suggestion: { type: 'string' },
              detail: { type: 'string' },
              copyable_prompt: { type: 'string' },
            },
            required: ['title', 'suggestion', 'detail', 'copyable_prompt'],
          },
        },
      },
      required: ['Qwen_md_additions', 'features_to_try', 'usage_patterns'],
    };

    const schemaInteractionStyle = {
      type: 'object',
      properties: {
        narrative: { type: 'string' },
        key_pattern: { type: 'string' },
      },
      required: ['narrative', 'key_pattern'],
    };

    const schemaAtAGlance = {
      type: 'object',
      properties: {
        whats_working: { type: 'string' },
        whats_hindering: { type: 'string' },
        quick_wins: { type: 'string' },
        ambitious_workflows: { type: 'string' },
      },
      required: [
        'whats_working',
        'whats_hindering',
        'quick_wins',
        'ambitious_workflows',
      ],
    };

    const limit = pLimit(CONCURRENCY_LIMIT);

    try {
      const [
        impressiveWorkflows,
        projectAreas,
        futureOpportunities,
        frictionPoints,
        memorableMoment,
        improvements,
        interactionStyle,
        atAGlance,
      ] = await Promise.all([
        limit(() =>
          generateJson<InsightImpressiveWorkflows>(
            getInsightPrompt('impressive_workflows'),
            schemaImpressiveWorkflows,
          ),
        ),
        limit(() =>
          generateJson<InsightProjectAreas>(
            getInsightPrompt('project_areas'),
            schemaProjectAreas,
          ),
        ),
        limit(() =>
          generateJson<InsightFutureOpportunities>(
            getInsightPrompt('future_opportunities'),
            schemaFutureOpportunities,
          ),
        ),
        limit(() =>
          generateJson<InsightFrictionPoints>(
            getInsightPrompt('friction_points'),
            schemaFrictionPoints,
          ),
        ),
        limit(() =>
          generateJson<InsightMemorableMoment>(
            getInsightPrompt('memorable_moment'),
            schemaMemorableMoment,
          ),
        ),
        limit(() =>
          generateJson<InsightImprovements>(
            getInsightPrompt('improvements'),
            schemaImprovements,
          ),
        ),
        limit(() =>
          generateJson<InsightInteractionStyle>(
            getInsightPrompt('interaction_style'),
            schemaInteractionStyle,
          ),
        ),
        limit(() =>
          generateJson<InsightAtAGlance>(
            getInsightPrompt('at_a_glance'),
            schemaAtAGlance,
          ),
        ),
      ]);

      logger.debug(
        JSON.stringify(
          {
            impressiveWorkflows,
            projectAreas,
            futureOpportunities,
            frictionPoints,
            memorableMoment,
            improvements,
            interactionStyle,
            atAGlance,
          },
          null,
          2,
        ),
      );

      return {
        impressiveWorkflows,
        projectAreas,
        futureOpportunities,
        frictionPoints,
        memorableMoment,
        improvements,
        interactionStyle,
        atAGlance,
      };
    } catch (e) {
      logger.error('Error generating qualitative insights:', e);
      return undefined;
    }
  }

  prepareCommonPromptData(
    metrics: Omit<InsightData, 'facets' | 'qualitative'>,
    facets: SessionFacets[],
  ): string {
    // 1. DATA section
    const goalsAgg: Record<string, number> = {};
    const outcomesAgg: Record<string, number> = {};
    const satisfactionAgg: Record<string, number> = {};
    const frictionAgg: Record<string, number> = {};
    const successAgg: Record<string, number> = {};

    facets.forEach((facet) => {
      // Aggregate goals
      Object.entries(facet.goal_categories).forEach(([goal, count]) => {
        goalsAgg[goal] = (goalsAgg[goal] || 0) + count;
      });

      // Aggregate outcomes
      outcomesAgg[facet.outcome] = (outcomesAgg[facet.outcome] || 0) + 1;

      // Aggregate satisfaction
      Object.entries(facet.user_satisfaction_counts).forEach(([sat, count]) => {
        satisfactionAgg[sat] = (satisfactionAgg[sat] || 0) + count;
      });

      // Aggregate friction
      Object.entries(facet.friction_counts).forEach(([fric, count]) => {
        frictionAgg[fric] = (frictionAgg[fric] || 0) + count;
      });

      // Aggregate success (primary_success)
      if (facet.primary_success && facet.primary_success !== 'none') {
        successAgg[facet.primary_success] =
          (successAgg[facet.primary_success] || 0) + 1;
      }
    });

    const topGoals = Object.entries(goalsAgg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    const dataObj = {
      sessions: metrics.totalSessions || facets.length,
      analyzed: facets.length,
      date_range: {
        start: Object.keys(metrics.heatmap).sort()[0] || 'N/A',
        end: Object.keys(metrics.heatmap).sort().pop() || 'N/A',
      },
      messages: metrics.totalMessages || 0,
      hours: metrics.totalHours || 0,
      commits: 0, // Not tracked yet
      top_tools: metrics.topTools || [],
      top_goals: topGoals,
      outcomes: outcomesAgg,
      satisfaction: satisfactionAgg,
      friction: frictionAgg,
      success: successAgg,
    };

    // 2. SESSION SUMMARIES section
    const sessionSummaries = facets
      .map((f) => `- ${f.brief_summary}`)
      .join('\n');

    // 3. FRICTION DETAILS section
    const frictionDetails = facets
      .filter((f) => f.friction_detail && f.friction_detail.trim().length > 0)
      .map((f) => `- ${f.friction_detail}`)
      .join('\n');

    return `DATA:
${JSON.stringify(dataObj, null, 2)}

SESSION SUMMARIES:
${sessionSummaries}

FRICTION DETAILS:
${frictionDetails}

USER INSTRUCTIONS TO Qwen:
None captured`;
  }
}
