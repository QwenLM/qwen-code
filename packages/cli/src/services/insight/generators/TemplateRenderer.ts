/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { InsightData } from '../types/StaticInsightTypes.js';

export class TemplateRenderer {
  private templateDir: string;

  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    this.templateDir = path.join(__dirname, '..', 'templates');
  }

  // Load template files
  private async loadTemplate(): Promise<string> {
    const templatePath = path.join(this.templateDir, 'insight-template.html');
    return await fs.readFile(templatePath, 'utf-8');
  }

  private async loadStyles(): Promise<string> {
    const stylesPath = path.join(this.templateDir, 'styles', 'base.css');
    return await fs.readFile(stylesPath, 'utf-8');
  }

  private async loadScripts(): Promise<string> {
    const scriptsPath = path.join(
      this.templateDir,
      'scripts',
      'insight-app.js',
    );
    return await fs.readFile(scriptsPath, 'utf-8');
  }

  // Render the complete HTML file
  async renderInsightHTML(insights: InsightData): Promise<string> {
    const template = await this.loadTemplate();
    const styles = await this.loadStyles();
    const scripts = await this.loadScripts();

    // Replace all placeholders
    let html = template;
    html = html.replace('{{STYLES_PLACEHOLDER}}', styles);
    html = html.replace('{{DATA_PLACEHOLDER}}', JSON.stringify(insights));
    html = html.replace('{{SCRIPTS_PLACEHOLDER}}', scripts);

    return html;
  }
}
