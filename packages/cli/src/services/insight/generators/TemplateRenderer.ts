/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import type { InsightData } from '../types/StaticInsightTypes.js';
import { setLanguageAsync, t } from '../../../i18n/index.js';
import type { SupportedLanguage } from '../../../i18n/index.js';

// All insight-related translation keys that need to be embedded in the HTML report
const INSIGHT_TRANSLATION_KEYS = [
  // Header
  'insight_title',
  'insight_messages_across_sessions',
  'insight_personalized_journey',

  // Stats
  'insight_stat_messages',
  'insight_stat_lines',
  'insight_stat_files',
  'insight_stat_days',
  'insight_stat_msgs_per_day',

  // Charts
  'insight_active_hours',
  'insight_morning',
  'insight_afternoon',
  'insight_evening',
  'insight_night',
  'insight_time_morning',
  'insight_time_afternoon',
  'insight_time_evening',
  'insight_time_night',
  'insight_activity_heatmap',
  'insight_heatmap_subtitle',
  'insight_less',
  'insight_more',
  'insight_activities',
  'insight_month_jan',
  'insight_month_feb',
  'insight_month_mar',
  'insight_month_apr',
  'insight_month_may',
  'insight_month_jun',
  'insight_month_jul',
  'insight_month_aug',
  'insight_month_sep',
  'insight_month_oct',
  'insight_month_nov',
  'insight_month_dec',

  // Qualitative - At a Glance
  'insight_at_a_glance',
  'insight_whats_working',
  'insight_whats_hindering',
  'insight_quick_wins',
  'insight_ambitious_workflows',
  'insight_see_more_wins',
  'insight_see_more_friction',
  'insight_see_more_features',
  'insight_see_more_horizon',

  // Qualitative - Navigation TOC
  'insight_nav_work',
  'insight_nav_usage',
  'insight_nav_wins',
  'insight_nav_friction',
  'insight_nav_features',
  'insight_nav_patterns',
  'insight_nav_horizon',

  // Qualitative - Project Areas
  'insight_what_you_work_on',
  'insight_sessions_count',
  'insight_what_you_wanted',
  'insight_top_tools_used',

  // Qualitative - Interaction Style
  'insight_how_you_use',
  'insight_key_pattern',

  // Qualitative - Impressive Workflows
  'insight_impressive_things',
  'insight_what_helped_most',
  'insight_outcomes',

  // Qualitative - Friction Points
  'insight_where_things_go_wrong',
  'insight_primary_friction_types',
  'insight_inferred_satisfaction',
  'insight_unclear',

  // Qualitative - Improvements
  'insight_features_to_try',
  'insight_suggested_qwen_md',
  'insight_qwen_md_hint',
  'insight_copy_all_checked',
  'insight_copied_all',
  'insight_why_for_you',
  'insight_features_hint',
  'insight_new_ways_to_use',
  'insight_patterns_hint',
  'insight_paste_into_qwen',

  // Qualitative - Future Opportunities
  'insight_on_the_horizon',
  'insight_getting_started',

  // Buttons & UI
  'insight_no_data',
  'insight_export_card',
  'insight_light_theme',
  'insight_dark_theme',
  'insight_export_not_available',
  'insight_export_failed',
  'insight_copy',
  'insight_copied',

  // Share Card
  'insight_share_sessions',
  'insight_share_lines_changed',
  'insight_share_streak',
  'insight_share_best_streak',
  'insight_share_activity',
  'insight_share_generated',
  'insight_share_github',
  'insight_share_brand',
];

/**
 * Builds a translation dictionary for the given language by loading
 * translations and extracting only the insight-related keys.
 */
async function buildInsightTranslations(
  language: string,
): Promise<Record<string, string>> {
  // Load translations for the target language
  await setLanguageAsync(language as SupportedLanguage);

  const dict: Record<string, string> = {};
  for (const key of INSIGHT_TRANSLATION_KEYS) {
    const value = t(key);
    // Only include if translation differs from key (i.e., actually translated)
    // or if it's a known key (value === key means English fallback)
    dict[key] = value;
  }
  return dict;
}

export class TemplateRenderer {
  // Render the complete HTML file
  async renderInsightHTML(
    insights: InsightData,
    language: string = 'en',
  ): Promise<string> {
    // Build translations dictionary for the target language
    const translations = await buildInsightTranslations(language);

    const html = `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${translations['insight_title'] || 'Qwen Code Insights'}</title>
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
      window.INSIGHT_LANGUAGE = ${JSON.stringify(language)};
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
