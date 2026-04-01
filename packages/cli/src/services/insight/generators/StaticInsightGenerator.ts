/**
 * @license
 * Copyright 2025 proto
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { DataProcessor } from './DataProcessor.js';
import { TemplateRenderer } from './TemplateRenderer.js';
import type {
  InsightData,
  InsightProgressCallback,
} from '../types/StaticInsightTypes.js';

import { updateSymlink, Storage, type Config } from '@qwen-code/qwen-code-core';

export class StaticInsightGenerator {
  private dataProcessor: DataProcessor;
  private templateRenderer: TemplateRenderer;

  constructor(config: Config) {
    this.dataProcessor = new DataProcessor(config);
    this.templateRenderer = new TemplateRenderer();
  }

  // Ensure the output directory exists
  private async ensureOutputDirectory(): Promise<string> {
    const outputDir = path.join(Storage.getRuntimeBaseDir(), 'insights');
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
  }

  // Generate timestamped filename with collision detection
  private async generateOutputPath(outputDir: string): Promise<string> {
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const time = now.toTimeString().slice(0, 8).replace(/:/g, ''); // HHMMSS

    let outputPath = path.join(outputDir, `insight-${date}.html`);

    // Check if date-only file exists, if so, add timestamp
    try {
      await fs.access(outputPath);
      // File exists, use timestamped version
      outputPath = path.join(outputDir, `insight-${date}-${time}.html`);
    } catch {
      // File doesn't exist, use date-only name
    }

    return outputPath;
  }

  private async updateInsightSymlink(
    outputDir: string,
    targetPath: string,
  ): Promise<void> {
    const latestPath = path.join(outputDir, 'insight.html');
    await updateSymlink(latestPath, targetPath);
  }

  // Generate the static insight HTML file
  async generateStaticInsight(
    baseDir: string,
    onProgress?: InsightProgressCallback,
  ): Promise<string> {
    // Ensure output directory exists
    const outputDir = await this.ensureOutputDirectory();
    const facetsDir = path.join(outputDir, 'facets');
    await fs.mkdir(facetsDir, { recursive: true });

    // Process data
    const insights: InsightData = await this.dataProcessor.generateInsights(
      baseDir,
      facetsDir,
      onProgress,
    );

    // Render HTML
    const html = await this.templateRenderer.renderInsightHTML(insights);

    // Generate timestamped output path
    const outputPath = await this.generateOutputPath(outputDir);

    // Write the HTML file
    await fs.writeFile(outputPath, html, 'utf-8');

    await this.updateInsightSymlink(outputDir, outputPath);

    return outputPath;
  }
}
