/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import {
  read as readJsonlFile,
  createDebugLogger,
  getInsightPrompt,
} from '@qwen-code/qwen-code-core';
import type { Config, ChatRecord } from '@qwen-code/qwen-code-core';
import pLimit from 'p-limit';
import type {
  SessionFacets,
  InsightProgressCallback,
} from '../types/StaticInsightTypes.js';

const logger = createDebugLogger('SessionAnalyzer');

const CONCURRENCY_LIMIT = 4;

/**
 * Analyzes individual sessions using the LLM to produce structured facets
 * (goals, outcomes, satisfaction, friction, etc.).
 */
export class SessionAnalyzer {
  constructor(private config: Config) {}

  // Format chat records for LLM analysis
  formatRecordsForAnalysis(records: ChatRecord[]): string {
    let output = '';
    const sessionStart =
      records.length > 0 ? new Date(records[0].timestamp) : new Date();

    output += `Session: ${records[0]?.sessionId || 'unknown'}\n`;
    output += `Date: ${sessionStart.toISOString()}\n`;
    output += `Duration: ${records.length} turns\n\n`;

    for (const record of records) {
      if (record.type === 'user') {
        const text =
          record.message?.parts
            ?.map((p) => ('text' in p ? p.text : ''))
            .join('') || '';
        output += `[User]: ${text}\n`;
      } else if (record.type === 'assistant') {
        if (record.message?.parts) {
          for (const part of record.message.parts) {
            if ('text' in part && part.text) {
              output += `[Assistant]: ${part.text}\n`;
            } else if ('functionCall' in part) {
              const call = part.functionCall;
              if (call) {
                output += `[Tool: ${call.name}]\n`;
              }
            }
          }
        }
      }
    }
    return output;
  }

  // Only analyze conversational sessions for facets (skip system-only logs).
  hasUserAndAssistantRecords(records: ChatRecord[]): boolean {
    let hasUser = false;
    let hasAssistant = false;

    for (const record of records) {
      if (record.type === 'user') {
        hasUser = true;
      } else if (record.type === 'assistant') {
        hasAssistant = true;
      }

      if (hasUser && hasAssistant) {
        return true;
      }
    }

    return false;
  }

  // Analyze a single session using LLM
  async analyzeSession(records: ChatRecord[]): Promise<SessionFacets | null> {
    if (records.length === 0) return null;

    const INSIGHT_SCHEMA = {
      type: 'object',
      properties: {
        underlying_goal: {
          type: 'string',
          description: 'What the user fundamentally wanted to achieve',
        },
        goal_categories: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
        outcome: {
          type: 'string',
          enum: [
            'fully_achieved',
            'mostly_achieved',
            'partially_achieved',
            'not_achieved',
            'unclear_from_transcript',
          ],
        },
        user_satisfaction_counts: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
        Qwen_helpfulness: {
          type: 'string',
          enum: [
            'unhelpful',
            'slightly_helpful',
            'moderately_helpful',
            'very_helpful',
            'essential',
          ],
        },
        session_type: {
          type: 'string',
          enum: [
            'single_task',
            'multi_task',
            'iterative_refinement',
            'exploration',
            'quick_question',
          ],
        },
        friction_counts: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
        friction_detail: {
          type: 'string',
          description: 'One sentence describing friction or empty',
        },
        primary_success: {
          type: 'string',
          enum: [
            'none',
            'fast_accurate_search',
            'correct_code_edits',
            'good_explanations',
            'proactive_help',
            'multi_file_changes',
            'good_debugging',
          ],
        },
        brief_summary: {
          type: 'string',
          description: 'One sentence: what user wanted and whether they got it',
        },
      },
      required: [
        'underlying_goal',
        'goal_categories',
        'outcome',
        'user_satisfaction_counts',
        'Qwen_helpfulness',
        'session_type',
        'friction_counts',
        'friction_detail',
        'primary_success',
        'brief_summary',
      ],
    };

    const sessionText = this.formatRecordsForAnalysis(records);
    const prompt = `${getInsightPrompt('analysis')}\n\nSESSION:\n${sessionText}`;

    try {
      const result = await this.config.getBaseLlmClient().generateJson({
        // Use the configured model
        model: this.config.getModel(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: INSIGHT_SCHEMA,
        abortSignal: AbortSignal.timeout(600000), // 10 minute timeout per session
      });

      if (!result || Object.keys(result).length === 0) {
        return null;
      }

      return {
        ...(result as unknown as SessionFacets),
        session_id: records[0].sessionId,
      };
    } catch (error) {
      logger.error(
        `Failed to analyze session ${records[0]?.sessionId}:`,
        error,
      );
      return null;
    }
  }

  async generateFacets(
    allFiles: Array<{ path: string; mtime: number }>,
    facetsOutputDir?: string,
    onProgress?: InsightProgressCallback,
  ): Promise<SessionFacets[]> {
    const MAX_ELIGIBLE_SESSIONS = 50;

    // Sort files by recency (descending), then select up to 50 conversational
    // sessions (must contain both user and assistant records).
    const sortedFiles = [...allFiles].sort((a, b) => b.mtime - a.mtime);
    const eligibleSessions: Array<{
      fileInfo: { path: string; mtime: number };
      records: ChatRecord[];
    }> = [];

    for (const fileInfo of sortedFiles) {
      if (eligibleSessions.length >= MAX_ELIGIBLE_SESSIONS) {
        break;
      }

      try {
        const records = await readJsonlFile<ChatRecord>(fileInfo.path);
        if (!this.hasUserAndAssistantRecords(records)) {
          continue;
        }
        eligibleSessions.push({ fileInfo, records });
      } catch (e) {
        logger.error(
          `Error reading session file ${fileInfo.path} for facet eligibility:`,
          e,
        );
      }
    }

    logger.info(
      `Analyzing ${eligibleSessions.length} eligible recent sessions with LLM...`,
    );

    // Create a limit function with concurrency of 4 to avoid 429 errors
    const limit = pLimit(CONCURRENCY_LIMIT);

    let completed = 0;
    const total = eligibleSessions.length;

    // Analyze sessions concurrently with limit
    const analysisPromises = eligibleSessions.map(({ fileInfo, records }) =>
      limit(async () => {
        try {
          // Check if we already have this session analyzed
          if (records.length > 0 && facetsOutputDir) {
            const sessionId = records[0].sessionId;
            if (sessionId) {
              const existingFacetPath = path.join(
                facetsOutputDir,
                `${sessionId}.json`,
              );
              try {
                // Check if file exists and is readable
                const existingData = await fs.readFile(
                  existingFacetPath,
                  'utf-8',
                );
                const existingFacet = JSON.parse(existingData);
                completed++;
                if (onProgress) {
                  const percent = 20 + Math.round((completed / total) * 60);
                  onProgress(
                    'Analyzing sessions',
                    percent,
                    `${completed}/${total}`,
                  );
                }
                return existingFacet;
              } catch (readError) {
                // File doesn't exist or is invalid, proceed to analyze
                if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
                  logger.warn(
                    `Failed to read existing facet for ${sessionId}, regenerating:`,
                    readError,
                  );
                }
              }
            }
          }

          const facet = await this.analyzeSession(records);

          if (facet && facetsOutputDir) {
            try {
              const facetPath = path.join(
                facetsOutputDir,
                `${facet.session_id}.json`,
              );
              await fs.writeFile(
                facetPath,
                JSON.stringify(facet, null, 2),
                'utf-8',
              );
            } catch (writeError) {
              logger.error(
                `Failed to write facet file for session ${facet.session_id}:`,
                writeError,
              );
            }
          }

          completed++;
          if (onProgress) {
            const percent = 20 + Math.round((completed / total) * 60);
            onProgress('Analyzing sessions', percent, `${completed}/${total}`);
          }

          return facet;
        } catch (e) {
          logger.error(`Error analyzing session file ${fileInfo.path}:`, e);
          completed++;
          if (onProgress) {
            const percent = 20 + Math.round((completed / total) * 60);
            onProgress('Analyzing sessions', percent, `${completed}/${total}`);
          }
          return null;
        }
      }),
    );

    const sessionFacetsWithNulls = await Promise.all(analysisPromises);
    const facets = sessionFacetsWithNulls.filter(
      (f): f is SessionFacets => f !== null,
    );
    return facets;
  }

  // Aggregate satisfaction, friction, success and outcome data from facets
  aggregateFacetsData(facets: SessionFacets[]): {
    satisfactionAgg: Record<string, number>;
    frictionAgg: Record<string, number>;
    primarySuccessAgg: Record<string, number>;
    outcomesAgg: Record<string, number>;
    goalsAgg: Record<string, number>;
  } {
    const satisfactionAgg: Record<string, number> = {};
    const frictionAgg: Record<string, number> = {};
    const primarySuccessAgg: Record<string, number> = {};
    const outcomesAgg: Record<string, number> = {};
    const goalsAgg: Record<string, number> = {};

    facets.forEach((facet) => {
      // Aggregate satisfaction
      Object.entries(facet.user_satisfaction_counts).forEach(([sat, count]) => {
        satisfactionAgg[sat] = (satisfactionAgg[sat] || 0) + count;
      });

      // Aggregate friction
      Object.entries(facet.friction_counts).forEach(([fric, count]) => {
        frictionAgg[fric] = (frictionAgg[fric] || 0) + count;
      });

      // Aggregate primary success
      if (facet.primary_success && facet.primary_success !== 'none') {
        primarySuccessAgg[facet.primary_success] =
          (primarySuccessAgg[facet.primary_success] || 0) + 1;
      }

      // Aggregate outcomes
      if (facet.outcome) {
        outcomesAgg[facet.outcome] = (outcomesAgg[facet.outcome] || 0) + 1;
      }

      // Aggregate goals
      Object.entries(facet.goal_categories).forEach(([goal, count]) => {
        goalsAgg[goal] = (goalsAgg[goal] || 0) + count;
      });
    });

    return {
      satisfactionAgg,
      frictionAgg,
      primarySuccessAgg,
      outcomesAgg,
      goalsAgg,
    };
  }
}
