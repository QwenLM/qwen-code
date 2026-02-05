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
import type { InsightData } from '../types/StaticInsightTypes.js';

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
  async generateStaticInsight(baseDir: string): Promise<string> {
    try {
      // Ensure output directory exists
      const outputDir = await this.ensureOutputDirectory();
      const facetsDir = path.join(outputDir, 'facets');
      await fs.mkdir(facetsDir, { recursive: true });

      // Process data
      console.log('Processing insight data...');
      const insights: InsightData = await this.dataProcessor.generateInsights(
        baseDir,
        facetsDir,
      );

      // Render HTML
      console.log('Rendering HTML template...');
      const html = await this.templateRenderer.renderInsightHTML(insights);

      const outputPath = path.join(outputDir, 'insight.html');

      // Write the HTML file
      console.log(`Writing HTML file to: ${outputPath}`);
      await fs.writeFile(outputPath, html, 'utf-8');

      // Write the JSON data file
      const jsonPath = path.join(outputDir, 'insight.json');
      console.log(`Writing JSON data to: ${jsonPath}`);

      // Exclude facets from the main JSON file as they are stored individually
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { facets, ...insightsWithoutFacets } = insights;

      await fs.writeFile(
        jsonPath,
        JSON.stringify(insightsWithoutFacets, null, 2),
        'utf-8',
      );

      console.log('Static insight generation completed successfully');
      return outputPath;
    } catch (error) {
      console.log(`Error generating static insight: ${error}`);
      throw error;
    }
  }
}
