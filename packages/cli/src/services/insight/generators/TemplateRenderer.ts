/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import type { InsightData } from '../types/StaticInsightTypes.js';

// Map language name to HTML lang attribute
function languageToHtmlLang(language?: string): string {
  if (!language) return 'en';
  const lowered = language.toLowerCase();
  const langMap: Record<string, string> = {
    chinese: 'zh-CN',
    zh: 'zh-CN',
    'zh-cn': 'zh-CN',
    russian: 'ru-RU',
    ru: 'ru-RU',
    'ru-ru': 'ru-RU',
    german: 'de-DE',
    de: 'de-DE',
    'de-de': 'de-DE',
    japanese: 'ja-JP',
    ja: 'ja-JP',
    'ja-jp': 'ja-JP',
    portuguese: 'pt-BR',
    pt: 'pt-BR',
    'pt-br': 'pt-BR',
    english: 'en',
    en: 'en',
    'en-us': 'en',
  };
  return langMap[lowered] || 'en';
}

export class TemplateRenderer {
  // Render the complete HTML file
  async renderInsightHTML(
    insights: InsightData,
    language?: string,
  ): Promise<string> {
    const htmlLang = languageToHtmlLang(language);
    // Include language in the insight data for the React app
    const insightDataWithLang = { ...insights, language };

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
      window.INSIGHT_DATA = ${JSON.stringify(insightDataWithLang)};
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
