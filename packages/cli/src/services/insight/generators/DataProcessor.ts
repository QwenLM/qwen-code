/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import type {
  InsightData,
  InsightProgressCallback,
} from '../types/StaticInsightTypes.js';
import { MetricsCalculator } from './MetricsCalculator.js';
import { SessionAnalyzer } from './SessionAnalyzer.js';
import { QualitativeInsightGenerator } from './QualitativeInsightGenerator.js';

const logger = createDebugLogger('DataProcessor');

/**
 * Orchestrates insight generation by delegating to specialized components:
 * - MetricsCalculator: heatmaps, streaks, tool usage, session durations
 * - SessionAnalyzer: LLM-based session facet analysis
 * - QualitativeInsightGenerator: LLM-based qualitative insight sections
 */
export class DataProcessor {
  private metricsCalculator: MetricsCalculator;
  private sessionAnalyzer: SessionAnalyzer;
  private qualitativeGenerator: QualitativeInsightGenerator;

  constructor(config: Config) {
    this.metricsCalculator = new MetricsCalculator();
    this.sessionAnalyzer = new SessionAnalyzer(config);
    this.qualitativeGenerator = new QualitativeInsightGenerator(config);
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
    const metrics = await this.metricsCalculator.generateMetrics(
      allChatFiles,
      onProgress,
    );

    if (onProgress) onProgress('Preparing sessions...', 20);
    const facets = await this.sessionAnalyzer.generateFacets(
      allChatFiles,
      facetsOutputDir,
      onProgress,
    );

    if (onProgress) onProgress('Generating personalized insights...', 80);
    const qualitative = await this.qualitativeGenerator.generate(
      metrics,
      facets,
    );

    // Aggregate satisfaction, friction, success and outcome data from facets
    const {
      satisfactionAgg,
      frictionAgg,
      primarySuccessAgg,
      outcomesAgg,
      goalsAgg,
    } = this.sessionAnalyzer.aggregateFacetsData(facets);

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
}
