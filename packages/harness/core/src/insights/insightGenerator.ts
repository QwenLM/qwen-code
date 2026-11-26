/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { systemPromptFromText } from '../prompts/system-prompt.js';
import type { Config } from '../config/config.js';
import * as insightModel from './modelRequest.js';
import type { AggregatedData, InsightResults, AtAGlance } from './types.js';

const TOTAL_SECTIONS = 7; // 6 parallel + 1 synthesis

/**
 * Generates multi-section insights by calling the LLM in parallel.
 */
export async function generateInsightResults(
  aggregated: AggregatedData,
  config: Config,
  abortSignal: AbortSignal,
  onSectionComplete: (completed: number, total: number) => void,
): Promise<InsightResults> {
  const sessionId = config.getSessionId();
  const dataContext = buildDataContext(aggregated);

  let completedCount = 0;
  const markComplete = () => {
    completedCount++;
    onSectionComplete(completedCount, TOTAL_SECTIONS);
  };

  const [
    summary,
    topTopics,
    topLanguages,
    activityPatterns,
    productivityTips,
    trends,
  ] = await Promise.all([
    // 1. Summary
    insightModel
      .generateInsight(config, {
        sessionId,
        messages: [
          {
            role: 'user',
            content: `Based on this usage data, write a concise 2-3 sentence summary of the user's coding activity patterns:\n\n${dataContext}`,
          },
        ],
        systemPrompt: systemPromptFromText(
          'You are a data analyst writing a brief executive summary of a developer\'s AI assistant usage. Be specific about numbers and patterns. Write in second person ("You...").',
        ),
        abortSignal,
        promptId: 'insights-summary',
      })
      .then((result) => {
        markComplete();
        return result;
      }),

    // 2. Top Topics
    insightModel
      .generateInsight(config, {
        sessionId,
        messages: [
          {
            role: 'user',
            content: `Based on this usage data, identify the top 5 topics with brief descriptions:\n\n${dataContext}`,
          },
        ],
        schema: {
          type: 'object',
          properties: {
            topics: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  count: { type: 'number' },
                  description: { type: 'string' },
                },
                required: ['name', 'count', 'description'],
              },
            },
          },
          required: ['topics'],
        },
        systemPrompt: systemPromptFromText(
          'Extract the top topics from the usage data. Provide a one-sentence description for each topic explaining what the user worked on.',
        ),
        abortSignal,
        promptId: 'insights-top-topics',
      })
      .then((result) => {
        markComplete();
        return parseTopTopics(result);
      }),

    // 3. Top Languages
    insightModel
      .generateInsight(config, {
        sessionId,
        messages: [
          {
            role: 'user',
            content: `Based on this usage data, identify the top programming languages used with percentages:\n\n${dataContext}`,
          },
        ],
        schema: {
          type: 'object',
          properties: {
            languages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  count: { type: 'number' },
                  percentage: { type: 'number' },
                },
                required: ['name', 'count', 'percentage'],
              },
            },
          },
          required: ['languages'],
        },
        systemPrompt: systemPromptFromText(
          'Extract the top programming languages from the usage data with counts and percentage of total sessions.',
        ),
        abortSignal,
        promptId: 'insights-top-languages',
      })
      .then((result) => {
        markComplete();
        return parseTopLanguages(result);
      }),

    // 4. Activity Patterns
    insightModel
      .generateInsight(config, {
        sessionId,
        messages: [
          {
            role: 'user',
            content: `Based on this usage data, describe the user's activity patterns (time of day, days of week, consistency):\n\n${dataContext}`,
          },
        ],
        systemPrompt: systemPromptFromText(
          "You are a productivity coach analyzing a developer's work patterns. Describe when they are most active, any notable patterns, and how consistent their usage is. Write 2-3 sentences in second person.",
        ),
        abortSignal,
        promptId: 'insights-activity-patterns',
      })
      .then((result) => {
        markComplete();
        return result;
      }),

    // 5. Productivity Tips
    insightModel
      .generateInsight(config, {
        sessionId,
        messages: [
          {
            role: 'user',
            content: `Based on this usage data, suggest 3-5 actionable productivity tips:\n\n${dataContext}`,
          },
        ],
        schema: {
          type: 'object',
          properties: {
            tips: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['tips'],
        },
        systemPrompt: systemPromptFromText(
          'You are a productivity coach for developers. Based on the usage data, suggest actionable tips to improve their workflow with the AI assistant. Each tip should be specific and practical (1-2 sentences).',
        ),
        abortSignal,
        promptId: 'insights-productivity-tips',
      })
      .then((result) => {
        markComplete();
        return asStringArray(result['tips']);
      }),

    // 6. Trends
    insightModel
      .generateInsight(config, {
        sessionId,
        messages: [
          {
            role: 'user',
            content: `Based on this usage data, describe any notable trends over time:\n\n${dataContext}`,
          },
        ],
        systemPrompt: systemPromptFromText(
          "You are a data analyst describing trends in a developer's AI assistant usage over time. Note any increases/decreases in activity, shifts in topics or languages, or changes in complexity. Write 2-3 sentences in second person.",
        ),
        abortSignal,
        promptId: 'insights-trends',
      })
      .then((result) => {
        markComplete();
        return result;
      }),
  ]);

  // Stage 2: Synthesize "At a Glance" from section results
  const atAGlance = await generateAtAGlance(
    {
      summary,
      topTopics,
      topLanguages,
      activityPatterns,
      productivityTips,
      trends,
    },
    dataContext,
    config,
    sessionId,
    abortSignal,
  );
  markComplete();

  return {
    summary,
    atAGlance,
    topTopics,
    topLanguages,
    activityPatterns,
    productivityTips,
    trends,
  };
}

function buildDataContext(aggregated: AggregatedData): string {
  const lines: string[] = [];

  lines.push(`Total sessions: ${aggregated.totalSessions}`);
  lines.push(`Total messages: ${aggregated.totalMessages}`);
  lines.push(`Total user messages: ${aggregated.totalUserMessages}`);
  lines.push(
    `Date range: ${new Date(aggregated.dateRange.start).toISOString().slice(0, 10)} to ${new Date(aggregated.dateRange.end).toISOString().slice(0, 10)}`,
  );

  lines.push('');
  lines.push('Topic frequency:');
  for (const [topic, count] of sortedEntries(aggregated.topicCounts, 10)) {
    lines.push(`  - ${topic}: ${count}`);
  }

  lines.push('');
  lines.push('Language frequency:');
  for (const [lang, count] of sortedEntries(aggregated.languageCounts, 10)) {
    lines.push(`  - ${lang}: ${count}`);
  }

  lines.push('');
  lines.push('Intent frequency:');
  for (const [intent, count] of sortedEntries(aggregated.intentCounts, 10)) {
    lines.push(`  - ${intent}: ${count}`);
  }

  lines.push('');
  lines.push('Hourly distribution (sessions per hour):');
  for (let h = 0; h < 24; h++) {
    if (aggregated.hourlyDistribution[h] > 0) {
      lines.push(
        `  - ${String(h).padStart(2, '0')}:00: ${aggregated.hourlyDistribution[h]}`,
      );
    }
  }

  lines.push('');
  lines.push(
    `Complexity: low=${aggregated.complexityDistribution.low}, medium=${aggregated.complexityDistribution.medium}, high=${aggregated.complexityDistribution.high}`,
  );

  lines.push('');
  lines.push('Daily activity (last 14 days):');
  const sortedDays = [...aggregated.dailyDistribution.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14);
  for (const [date, count] of sortedDays) {
    lines.push(`  - ${date}: ${count} sessions`);
  }

  return lines.join('\n');
}

function sortedEntries(
  map: Map<string, number>,
  limit: number,
): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function isStringProp(obj: Record<string, unknown>, key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(obj, key) &&
    typeof obj[key] === 'string'
  );
}

function isObjectWithProp(
  value: unknown,
  prop: string,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, prop)
  );
}

function parseTopTopics(
  result: Record<string, unknown>,
): Array<{ name: string; count: number; description: string }> {
  const topics = result['topics'];
  if (!Array.isArray(topics)) return [];
  return topics
    .filter(
      (t): t is { name: string; count: number; description: string } =>
        isObjectWithProp(t, 'name') && isObjectWithProp(t, 'description'),
    )
    .map((t) => ({
      name: String(t.name),
      count: Number(t.count) || 0,
      description: String(t.description),
    }));
}

function parseTopLanguages(
  result: Record<string, unknown>,
): Array<{ name: string; count: number; percentage: number }> {
  const languages = result['languages'];
  if (!Array.isArray(languages)) return [];
  return languages
    .filter((l): l is { name: string; count: number; percentage: number } =>
      isObjectWithProp(l, 'name'),
    )
    .map((l) => ({
      name: String(l.name),
      count: Number(l.count) || 0,
      percentage: Number(l.percentage) || 0,
    }));
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/**
 * Stage 2: Synthesize "At a Glance" from already-generated section results.
 * This produces a higher-level overview that cross-references findings.
 */
async function generateAtAGlance(
  sections: {
    summary: string;
    topTopics: Array<{ name: string; count: number; description: string }>;
    topLanguages: Array<{ name: string; count: number; percentage: number }>;
    activityPatterns: string;
    productivityTips: string[];
    trends: string;
  },
  dataContext: string,
  config: Config,
  sessionId: string,
  abortSignal: AbortSignal,
): Promise<AtAGlance> {
  // Build rich context from the generated sections
  const topicsText = sections.topTopics
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');
  const languagesText = sections.topLanguages
    .map((l) => `- ${l.name} (${l.percentage}%)`)
    .join('\n');
  const tipsText = sections.productivityTips.map((t) => `- ${t}`).join('\n');

  const synthesisPrompt = `You are analyzing a developer's AI assistant usage to produce an executive "At a Glance" overview.

Here is the raw usage data:
${dataContext}

Here are the already-generated insight sections:

SUMMARY:
${sections.summary}

TOP TOPICS:
${topicsText}

LANGUAGES:
${languagesText}

ACTIVITY PATTERNS:
${sections.activityPatterns}

TRENDS:
${sections.trends}

PRODUCTIVITY TIPS:
${tipsText}

Based on ALL the above, produce a synthesized "At a Glance" overview with 4 parts:
1. "whatsWorking" — What's working well: describe the user's strengths and effective patterns (2-3 sentences)
2. "whatsHindering" — What's hindering them: identify friction points or missed opportunities (2-3 sentences)
3. "quickWins" — 3 specific, actionable quick wins they can try immediately
4. "ambitiousWorkflows" — 2-3 ambitious workflows or advanced techniques they could adopt as they grow`;

  try {
    const result = await insightModel.generateInsight(config, {
      sessionId,
      messages: [{ role: 'user', content: synthesisPrompt }],
      schema: {
        type: 'object',
        properties: {
          whatsWorking: { type: 'string' },
          whatsHindering: { type: 'string' },
          quickWins: { type: 'array', items: { type: 'string' } },
          ambitiousWorkflows: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'whatsWorking',
          'whatsHindering',
          'quickWins',
          'ambitiousWorkflows',
        ],
      },
      systemPrompt: systemPromptFromText(
        'You are a senior developer productivity coach. Synthesize insights from multiple analysis sections into a cohesive, actionable overview. Write in second person ("You..."). Be specific — reference actual topics, languages, and patterns from the data.',
      ),
      abortSignal,
      promptId: 'insights-at-a-glance',
    });

    return {
      whatsWorking: isStringProp(result, 'whatsWorking')
        ? String(result['whatsWorking'])
        : '',
      whatsHindering: isStringProp(result, 'whatsHindering')
        ? String(result['whatsHindering'])
        : '',
      quickWins: asStringArray(result['quickWins']),
      ambitiousWorkflows: asStringArray(result['ambitiousWorkflows']),
    };
  } catch {
    return {
      whatsWorking: sections.summary,
      whatsHindering: '',
      quickWins: sections.productivityTips.slice(0, 3),
      ambitiousWorkflows: [],
    };
  }
}
