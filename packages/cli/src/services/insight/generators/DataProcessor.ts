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
} from '@qwen-code/qwen-code-core';
import pLimit from 'p-limit';
import type {
  InsightData,
  HeatMapData,
  StreakData,
  SessionFacets,
  InsightProgressCallback,
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
import {
  getInsightPrompt,
  type Config,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';

const logger = createDebugLogger('DataProcessor');

const CONCURRENCY_LIMIT = 4;

export class DataProcessor {
  constructor(private config: Config) {}

  // Helper function to format date as YYYY-MM-DD
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // Format chat records for LLM analysis
  private formatRecordsForAnalysis(records: ChatRecord[]): string {
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
  private hasUserAndAssistantRecords(records: ChatRecord[]): boolean {
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
  private async analyzeSession(
    records: ChatRecord[],
  ): Promise<SessionFacets | null> {
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

  // Calculate streaks from activity dates
  private calculateStreaks(dates: string[]): StreakData {
    if (dates.length === 0) {
      return { currentStreak: 0, longestStreak: 0, dates: [] };
    }

    // Convert string dates to Date objects and sort them
    const dateObjects = dates.map((dateStr) => new Date(dateStr));
    dateObjects.sort((a, b) => a.getTime() - b.getTime());

    let currentStreak = 1;
    let maxStreak = 1;
    let currentDate = new Date(dateObjects[0]);
    currentDate.setHours(0, 0, 0, 0); // Normalize to start of day

    for (let i = 1; i < dateObjects.length; i++) {
      const nextDate = new Date(dateObjects[i]);
      nextDate.setHours(0, 0, 0, 0); // Normalize to start of day

      // Calculate difference in days
      const diffDays = Math.floor(
        (nextDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (diffDays === 1) {
        // Consecutive day
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else if (diffDays > 1) {
        // Gap in streak
        currentStreak = 1;
      }
      // If diffDays === 0, same day, so streak continues

      currentDate = nextDate;
    }

    // Check if the streak is still ongoing (if last activity was yesterday or today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (
      currentDate.getTime() === today.getTime() ||
      currentDate.getTime() === yesterday.getTime()
    ) {
      // The streak might still be active, so we don't reset it
    }

    return {
      currentStreak,
      longestStreak: maxStreak,
      dates,
    };
  }

  // Process chat files from all projects in the base directory and generate insights
  async generateInsights(
    baseDir: string,
    facetsOutputDir?: string,
    onProgress?: InsightProgressCallback,
  ): Promise<InsightData> {
    if (onProgress) onProgress('Scanning chat history...', 0);
    const allChatFiles = await this.scanChatFiles(baseDir);

    if (onProgress) onProgress('Crunching the numbers', 10);
    const metrics = await this.generateMetrics(allChatFiles, onProgress);

    if (onProgress) onProgress('Preparing sessions...', 20);
    const facets = await this.generateFacets(
      allChatFiles,
      facetsOutputDir,
      onProgress,
    );

    if (onProgress) onProgress('Generating personalized insights...', 80);
    const qualitative = await this.generateQualitativeInsights(metrics, facets);

    // Aggregate satisfaction, friction, success and outcome data from facets
    const {
      satisfactionAgg,
      frictionAgg,
      primarySuccessAgg,
      outcomesAgg,
      goalsAgg,
    } = this.aggregateFacetsData(facets);

    if (onProgress) onProgress('Assembling report...', 100);

    return {
      ...metrics,
      qualitative,
      satisfaction: satisfactionAgg,
      friction: frictionAgg,
      primarySuccess: primarySuccessAgg,
      outcomes: outcomesAgg,
      topGoals: goalsAgg,
    };
  }

  // Aggregate satisfaction and friction data from facets
  private aggregateFacetsData(facets: SessionFacets[]): {
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

  private async generateQualitativeInsights(
    metrics: Omit<InsightData, 'facets' | 'qualitative'>,
    facets: SessionFacets[],
  ): Promise<QualitativeInsights | undefined> {
    if (facets.length === 0) {
      return undefined;
    }

    logger.info('Generating qualitative insights...');

    const commonData = this.prepareCommonPromptData(metrics, facets);

    const generate = async <T>(
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
    // We define simplified schemas here to guide the LLM.
    // The types are already defined in QualitativeInsightTypes.ts

    // 1. Impressive Workflows
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

    // 2. Project Areas
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

    // 3. Future Opportunities
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

    // 4. Friction Points
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

    // 5. Memorable Moment
    const schemaMemorableMoment = {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['headline', 'detail'],
    };

    // 6. Improvements
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

    // 7. Interaction Style
    const schemaInteractionStyle = {
      type: 'object',
      properties: {
        narrative: { type: 'string' },
        key_pattern: { type: 'string' },
      },
      required: ['narrative', 'key_pattern'],
    };

    // 8. At A Glance
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
          generate<InsightImpressiveWorkflows>(
            getInsightPrompt('impressive_workflows'),
            schemaImpressiveWorkflows,
          ),
        ),
        limit(() =>
          generate<InsightProjectAreas>(
            getInsightPrompt('project_areas'),
            schemaProjectAreas,
          ),
        ),
        limit(() =>
          generate<InsightFutureOpportunities>(
            getInsightPrompt('future_opportunities'),
            schemaFutureOpportunities,
          ),
        ),
        limit(() =>
          generate<InsightFrictionPoints>(
            getInsightPrompt('friction_points'),
            schemaFrictionPoints,
          ),
        ),
        limit(() =>
          generate<InsightMemorableMoment>(
            getInsightPrompt('memorable_moment'),
            schemaMemorableMoment,
          ),
        ),
        limit(() =>
          generate<InsightImprovements>(
            getInsightPrompt('improvements'),
            schemaImprovements,
          ),
        ),
        limit(() =>
          generate<InsightInteractionStyle>(
            getInsightPrompt('interaction_style'),
            schemaInteractionStyle,
          ),
        ),
        limit(() =>
          generate<InsightAtAGlance>(
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

  private prepareCommonPromptData(
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

  private async scanChatFiles(
    baseDir: string,
  ): Promise<Array<{ path: string; mtime: number }>> {
    const allChatFiles: Array<{ path: string; mtime: number }> = [];

    try {
      // Get all project directories in the base directory
      const projectDirs = await fs.readdir(baseDir);

      // Process each project directory
      for (const projectDir of projectDirs) {
        const projectPath = path.join(baseDir, projectDir);
        const stats = await fs.stat(projectPath);

        // Only process if it's a directory
        if (stats.isDirectory()) {
          const chatsDir = path.join(projectPath, 'chats');

          try {
            // Get all chat files in the chats directory
            const files = await fs.readdir(chatsDir);
            const chatFiles = files.filter((file) => file.endsWith('.jsonl'));

            for (const file of chatFiles) {
              const filePath = path.join(chatsDir, file);

              // Get file stats for sorting by recency
              try {
                const fileStats = await fs.stat(filePath);
                allChatFiles.push({ path: filePath, mtime: fileStats.mtimeMs });
              } catch (e) {
                logger.error(`Failed to stat file ${filePath}:`, e);
              }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              logger.error(
                `Error reading chats directory for project ${projectDir}: ${error}`,
              );
            }
            // Continue to next project if chats directory doesn't exist
            continue;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Base directory doesn't exist, return empty
        logger.info(`Base directory does not exist: ${baseDir}`);
      } else {
        logger.error(`Error reading base directory: ${error}`);
      }
    }

    return allChatFiles;
  }

  private async generateMetrics(
    files: Array<{ path: string; mtime: number }>,
    onProgress?: InsightProgressCallback,
  ): Promise<Omit<InsightData, 'facets' | 'qualitative'>> {
    // Initialize data structures
    const heatmap: HeatMapData = {};
    const activeHours: { [hour: number]: number } = {};
    const sessionStartTimes: { [sessionId: string]: Date } = {};
    const sessionEndTimes: { [sessionId: string]: Date } = {};
    let totalMessages = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const uniqueFiles = new Set<string>();
    const toolUsage: Record<string, number> = {};

    // Process files in batches to avoid OOM and blocking the event loop
    const BATCH_SIZE = 50;
    const totalFiles = files.length;

    for (let i = 0; i < totalFiles; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, totalFiles);
      const batch = files.slice(i, batchEnd);

      // Process batch sequentially to minimize memory usage
      for (const fileInfo of batch) {
        try {
          const records = await readJsonlFile<ChatRecord>(fileInfo.path);

          // Process each record
          for (const record of records) {
            const timestamp = new Date(record.timestamp);
            const dateKey = this.formatDate(timestamp);
            const hour = timestamp.getHours();

            // Count user messages and slash commands (actual user interactions)
            const isUserMessage = record.type === 'user';
            const isSlashCommand =
              record.type === 'system' && record.subtype === 'slash_command';
            if (isUserMessage || isSlashCommand) {
              totalMessages++;

              // Update heatmap (count of user interactions per day)
              heatmap[dateKey] = (heatmap[dateKey] || 0) + 1;

              // Update active hours
              activeHours[hour] = (activeHours[hour] || 0) + 1;
            }

            // Track session times
            if (!sessionStartTimes[record.sessionId]) {
              sessionStartTimes[record.sessionId] = timestamp;
            }
            sessionEndTimes[record.sessionId] = timestamp;

            // Track tool usage
            if (record.type === 'assistant' && record.message?.parts) {
              for (const part of record.message.parts) {
                if ('functionCall' in part) {
                  const name = part.functionCall!.name!;
                  toolUsage[name] = (toolUsage[name] || 0) + 1;
                }
              }
            }

            // Track lines and files from tool results
            if (
              record.type === 'tool_result' &&
              record.toolCallResult?.resultDisplay
            ) {
              const display = record.toolCallResult.resultDisplay;
              // Check if it matches FileDiff shape
              if (
                typeof display === 'object' &&
                display !== null &&
                'fileName' in display
              ) {
                // Cast to any to avoid importing FileDiff type which might not be available here
                const diff = display as {
                  fileName: unknown;
                  diffStat?: {
                    model_added_lines?: number;
                    model_removed_lines?: number;
                  };
                };
                if (typeof diff.fileName === 'string') {
                  uniqueFiles.add(diff.fileName);
                }

                if (diff.diffStat) {
                  totalLinesAdded += diff.diffStat.model_added_lines || 0;
                  totalLinesRemoved += diff.diffStat.model_removed_lines || 0;
                }
              }
            }
          }
        } catch (error) {
          logger.error(
            `Failed to process metrics for file ${fileInfo.path}:`,
            error,
          );
          // Continue to next file
        }
      }

      // Update progress (mapped to 10-20% range of total progress)
      if (onProgress) {
        const percentComplete = batchEnd / totalFiles;
        const overallProgress = 10 + Math.round(percentComplete * 10);
        onProgress(
          `Crunching the numbers (${batchEnd}/${totalFiles})`,
          overallProgress,
        );
      }

      // Yield to event loop to allow GC and UI updates
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Calculate streak data
    const streakData = this.calculateStreaks(Object.keys(heatmap));

    // Calculate longest work session and total hours
    let longestWorkDuration = 0;
    let longestWorkDate: string | null = null;
    let totalDurationMs = 0;

    const sessionIds = Object.keys(sessionStartTimes);
    const totalSessions = sessionIds.length;

    for (const sessionId of sessionIds) {
      const start = sessionStartTimes[sessionId];
      const end = sessionEndTimes[sessionId];
      const durationMs = end.getTime() - start.getTime();
      const durationMinutes = Math.round(durationMs / (1000 * 60));

      totalDurationMs += durationMs;

      if (durationMinutes > longestWorkDuration) {
        longestWorkDuration = durationMinutes;
        longestWorkDate = this.formatDate(start);
      }
    }

    const totalHours = Math.round(totalDurationMs / (1000 * 60 * 60));

    // Calculate latest active time
    let latestActiveTime: string | null = null;
    let latestTimestamp = new Date(0);
    for (const dateStr in heatmap) {
      const date = new Date(dateStr);
      if (date > latestTimestamp) {
        latestTimestamp = date;
        latestActiveTime = date.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    }

    // Calculate top tools
    const topTools = Object.entries(toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return {
      heatmap,
      currentStreak: streakData.currentStreak,
      longestStreak: streakData.longestStreak,
      longestWorkDate,
      longestWorkDuration,
      activeHours,
      latestActiveTime,
      totalSessions,
      totalMessages,
      totalHours,
      topTools,
      totalLinesAdded,
      totalLinesRemoved,
      totalFiles: uniqueFiles.size,
    };
  }

  private async generateFacets(
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
}
