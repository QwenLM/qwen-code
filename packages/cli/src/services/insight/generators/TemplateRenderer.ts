/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import type { InsightData } from '../types/StaticInsightTypes.js';

// Insight report translations for HTML UI
const INSIGHT_TRANSLCTIONS: Record<string, Record<string, string>> = {
  en: {
    'Qwen Code Insights': 'Qwen Code Insights',
    '{{count}} messages across {{sessions}} sessions':
      '{{count}} messages across {{sessions}} sessions',
    'Your personalized coding journey and patterns':
      'Your personalized coding journey and patterns',
    'Export Card': 'Export Card',
    'Light Theme': 'Light Theme',
    'Dark Theme': 'Dark Theme',
    Messages: 'Messages',
    Lines: 'Lines',
    Files: 'Files',
    Days: 'Days',
    'Msgs/Day': 'Msgs/Day',
    'At a Glance': 'At a Glance',
    "What's working:": "What's working:",
    "What's hindering you:": "What's hindering you:",
    'Quick wins to try:': 'Quick wins to try:',
    'Ambitious workflows:': 'Ambitious workflows:',
    'Impressive Things You Did →': 'Impressive Things You Did →',
    'Where Things Go Wrong →': 'Where Things Go Wrong →',
    'Features to Try →': 'Features to Try →',
    'On the Horizon →': 'On the Horizon →',
    'What You Work On': 'What You Work On',
    'How You Use Qwen Code': 'How You Use Qwen Code',
    'Impressive Things': 'Impressive Things',
    'Where Things Go Wrong': 'Where Things Go Wrong',
    'Features to Try': 'Features to Try',
    'New Usage Patterns': 'New Usage Patterns',
    'On the Horizon': 'On the Horizon',
    '~{{count}} sessions': '~{{count}} sessions',
    'What You Wanted': 'What You Wanted',
    'Top Tools Used': 'Top Tools Used',
    'Key pattern:': 'Key pattern:',
    'Impressive Things You Did': 'Impressive Things You Did',
    "What Helped Most (Qwen's Capabilities)":
      "What Helped Most (Qwen's Capabilities)",
    Outcomes: 'Outcomes',
    'Primary Friction Types': 'Primary Friction Types',
    'Inferred Satisfaction (model-estimated)':
      'Inferred Satisfaction (model-estimated)',
    'Existing Qwen Code Features to Try': 'Existing Qwen Code Features to Try',
    'Suggested QWEN.md Additions': 'Suggested QWEN.md Additions',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Just copy this into Qwen Code to add it to your QWEN.md.',
    'Copy All Checked ({{count}})': 'Copy All Checked ({{count}})',
    'Copied All!': 'Copied All!',
    "Just copy this into Qwen Code and it'll set it up for you.":
      "Just copy this into Qwen Code and it'll set it up for you.",
    'Why for you:': 'Why for you:',
    'New Ways to Use Qwen Code': 'New Ways to Use Qwen Code',
    "Just copy this into Qwen Code and it'll walk you through it.":
      "Just copy this into Qwen Code and it'll walk you through it.",
    'Paste into Qwen Code:': 'Paste into Qwen Code:',
    'Getting started:': 'Getting started:',
  },
};

export class TemplateRenderer {
  private language: string;

  constructor(language?: string) {
    this.language = language || 'en';
  }

  // Render the complete HTML file
  async renderInsightHTML(
    insights: InsightData,
    language?: string,
  ): Promise<string> {
    const lang = language || this.language;
    const translations =
      INSIGHT_TRANSLCTIONS[lang] || INSIGHT_TRANSLCTIONS['en'];

    const html = `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${translations['Qwen Code Insights']}</title>
    <style>
      ${INSIGHT_CSS}
    </style>
  </head>
  <body>
    <div class="min-h-screen" id="container">
      <div class="mx-auto max-w-6xl px-6 py-10 md:py-12">
        <div id="react-root"></div>
      </div>
    </div>

    <!-- React CDN -->
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

    <!-- CDN Libraries -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>

    <!-- Application Data -->
    <script>
      window.INSIGHT_DATA = ${JSON.stringify(insights)};
      window.INSIGHT_LOCALE = '${lang}';
      window.INSIGHT_TRANSLATIONS = ${JSON.stringify(translations)};
    </script>

    <!-- App Script -->
    <script>
      ${INSIGHT_JS}
    </script>
  </body>
</html>`;

    return html;
  }
}
