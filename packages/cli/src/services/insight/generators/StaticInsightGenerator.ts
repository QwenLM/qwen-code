/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { DataProcessor } from './DataProcessor.js';
import { TemplateRenderer } from './TemplateRenderer.js';
import type {
  InsightData,
  InsightProgressCallback,
} from '../types/StaticInsightTypes.js';

import type { Config } from '@qwen-code/qwen-code-core';

export class StaticInsightGenerator {
  private dataProcessor: DataProcessor;
  private templateRenderer: TemplateRenderer;

  constructor(config: Config) {
    this.dataProcessor = new DataProcessor(config);
    this.templateRenderer = new TemplateRenderer();
  }

  // Ensure the output directory exists
  private async ensureOutputDirectory(): Promise<string> {
    const outputDir = path.join(os.homedir(), '.qwen', 'insights');
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
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

    const outputPath = path.join(outputDir, 'insight.html');

    // Write the HTML file
    await fs.writeFile(outputPath, html, 'utf-8');
    return outputPath;
  }
}
