/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import type { InsightData } from '../types/StaticInsightTypes.js';

/**
 * Localized strings for the insight report
 */
export interface InsightLocalizedStrings {
  language: string;
  title: string;
  subtitle: string;
  messagesAcrossSessions: string;
  atAGlance: string;
  whatsWorking: string;
  whatsHindering: string;
  quickWins: string;
  ambitiousWorkflows: string;
  impressiveThingsYouDid: string;
  whereThingsGoWrong: string;
  existingFeaturesToTry: string;
  newWaysToUse: string;
  onTheHorizon: string;
  whatYouWorkOn: string;
  howYouUseQwenCode: string;
  whatYouWanted: string;
  topToolsUsed: string;
  whatHelpedMost: string;
  outcomes: string;
  primaryFrictionTypes: string;
  inferredSatisfaction: string;
  suggestedQwenMdAdditions: string;
  copyToQwenMd: string;
  copyAllChecked: string;
  copiedAll: string;
  whyForYou: string;
  pasteIntoQwenCode: string;
  gettingStarted: string;
  keyPattern: string;
  exportCard: string;
  lightTheme: string;
  darkTheme: string;
  noDataAvailable: string;
  seeMoreImpressive: string;
  seeMoreFriction: string;
  seeMoreFeatures: string;
  seeMoreHorizon: string;
  outputLanguage?: string;
  [key: string]: string | undefined;
}

/**
 * Get default English localized strings
 */
export function getDefaultLocalizedStrings(): InsightLocalizedStrings {
  return {
    language: 'en',
    title: 'Qwen Code Insights',
    subtitle: 'Your personalized coding journey and patterns',
    messagesAcrossSessions: 'messages across {{sessions}} sessions',
    atAGlance: 'At a Glance',
    whatsWorking: "What's working:",
    whatsHindering: "What's hindering you:",
    quickWins: 'Quick wins to try:',
    ambitiousWorkflows: 'Ambitious workflows:',
    impressiveThingsYouDid: 'Impressive Things You Did',
    whereThingsGoWrong: 'Where Things Go Wrong',
    existingFeaturesToTry: 'Existing Qwen Code Features to Try',
    newWaysToUse: 'New Ways to Use Qwen Code',
    onTheHorizon: 'On the Horizon',
    whatYouWorkOn: 'What You Work On',
    howYouUseQwenCode: 'How You Use Qwen Code',
    whatYouWanted: 'What You Wanted',
    topToolsUsed: 'Top Tools Used',
    whatHelpedMost: "What Helped Most (Qwen's Capabilities)",
    outcomes: 'Outcomes',
    primaryFrictionTypes: 'Primary Friction Types',
    inferredSatisfaction: 'Inferred Satisfaction (model-estimated)',
    suggestedQwenMdAdditions: 'Suggested QWEN.md Additions',
    copyToQwenMd: 'Just copy this into Qwen Code to add it to your QWEN.md.',
    copyAllChecked: 'Copy All Checked',
    copiedAll: 'Copied All!',
    whyForYou: 'Why for you:',
    pasteIntoQwenCode: 'Paste into Qwen Code:',
    gettingStarted: 'Getting started:',
    keyPattern: 'Key pattern:',
    exportCard: 'Export Card',
    lightTheme: 'Light Theme',
    darkTheme: 'Dark Theme',
    noDataAvailable: 'No insight data available',
    seeMoreImpressive: 'Impressive Things You Did →',
    seeMoreFriction: 'Where Things Go Wrong →',
    seeMoreFeatures: 'Features to Try →',
    seeMoreHorizon: 'On the Horizon →',
  };
}

export class TemplateRenderer {
  // Render the complete HTML file
  async renderInsightHTML(
    insights: InsightData,
    localizedStrings?: InsightLocalizedStrings,
  ): Promise<string> {
    const strings = localizedStrings || getDefaultLocalizedStrings();

    const html = `<!doctype html>
<html lang="${strings.language}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${strings.title}</title>
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
      window.INSIGHT_I18N = ${JSON.stringify(strings)};
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
