/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import type { InsightData } from '../types/StaticInsightTypes.js';
import type { SupportedLanguage } from '../../../i18n/index.js';

// Language codes for HTML lang attribute
const HTML_LANG_CODES: Record<SupportedLanguage, string> = {
  en: 'en',
  zh: 'zh-CN',
  ja: 'ja',
  de: 'de',
  pt: 'pt-BR',
  ru: 'ru',
};

export class TemplateRenderer {
  constructor(private language: SupportedLanguage = 'en') {}

  // Render the complete HTML file
  async renderInsightHTML(insights: InsightData): Promise<string> {
    const htmlLang = HTML_LANG_CODES[this.language];
    const html = `<!doctype html>
<html lang="${htmlLang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Qwen Code Insights</title>
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
      window.INSIGHT_LANGUAGE = ${JSON.stringify(this.language)};
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
