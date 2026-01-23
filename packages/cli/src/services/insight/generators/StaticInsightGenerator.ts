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

export class StaticInsightGenerator {
  private dataProcessor: DataProcessor;
  private templateRenderer: TemplateRenderer;

  constructor() {
    this.dataProcessor = new DataProcessor();
    this.templateRenderer = new TemplateRenderer();
  }

  private debugLog(message: string) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
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
      this.debugLog('Starting static insight generation...');

      // Process data
      this.debugLog('Processing insight data...');
      const insights: InsightData = await this.dataProcessor.generateInsights(baseDir);

      // Render HTML
      this.debugLog('Rendering HTML template...');
      const html = await this.templateRenderer.renderInsightHTML(insights);

      // Ensure output directory exists
      const outputDir = await this.ensureOutputDirectory();
      const outputPath = path.join(outputDir, 'insight.html');

      // Write the HTML file
      this.debugLog(`Writing HTML file to: ${outputPath}`);
      await fs.writeFile(outputPath, html, 'utf-8');

      this.debugLog('Static insight generation completed successfully');
      return outputPath;
    } catch (error) {
      this.debugLog(`Error generating static insight: ${error}`);
      throw error;
    }
  }

  // Get the default output path
  getDefaultOutputPath(): string {
    return path.join(os.homedir(), '.qwen', 'insights', 'insight.html');
  }

  // Check if insight file exists
  async insightFileExists(): Promise<boolean> {
    try {
      const outputPath = this.getDefaultOutputPath();
      await fs.access(outputPath);
      return true;
    } catch {
      return false;
    }
  }

  // Get insight file stats (for checking modification time)
  async getInsightFileStats() {
    const outputPath = this.getDefaultOutputPath();
    return await fs.stat(outputPath);
  }
}