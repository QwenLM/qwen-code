/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import type { HistoryItemInsightProgress } from '../types.js';
import { t, getCurrentLanguage } from '../../i18n/index.js';
import { getLanguageNameFromLocale } from '../../i18n/languages.js';
import { resolveOutputLanguage } from '../../utils/languageUtils.js';
import { join } from 'path';
import os from 'os';
import {
  getDefaultLocalizedStrings,
  type InsightLocalizedStrings,
} from '../../services/insight/generators/TemplateRenderer.js';
import { StaticInsightGenerator } from '../../services/insight/generators/StaticInsightGenerator.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import open from 'open';

const logger = createDebugLogger('DataProcessor');

/**
 * Build localized strings for the insight report based on user settings
 */
function buildLocalizedStrings(outputLangSetting?: string): InsightLocalizedStrings {
  const currentLang = getCurrentLanguage();
  const outputLang = resolveOutputLanguage(outputLangSetting || 'auto');

  // Get translations using the t function
  const strings = getDefaultLocalizedStrings();

  // Override with translated strings
  strings.language = currentLang;
  strings.title = t('Qwen Code Insights');
  strings.subtitle = t('Your personalized coding journey and patterns');
  strings.messagesAcrossSessions = t('messages across {{sessions}} sessions');
  strings.atAGlance = t('At a Glance');
  strings.whatsWorking = t("What's working:");
  strings.whatsHindering = t("What's hindering you:");
  strings.quickWins = t('Quick wins to try:');
  strings.ambitiousWorkflows = t('Ambitious workflows:');
  strings.impressiveThingsYouDid = t('Impressive Things You Did');
  strings.whereThingsGoWrong = t('Where Things Go Wrong');
  strings.existingFeaturesToTry = t('Existing Qwen Code Features to Try');
  strings.newWaysToUse = t('New Ways to Use Qwen Code');
  strings.onTheHorizon = t('On the Horizon');
  strings.whatYouWorkOn = t('What You Work On');
  strings.howYouUseQwenCode = t('How You Use Qwen Code');
  strings.whatYouWanted = t('What You Wanted');
  strings.topToolsUsed = t('Top Tools Used');
  strings.whatHelpedMost = t("What Helped Most (Qwen's Capabilities)");
  strings.outcomes = t('Outcomes');
  strings.primaryFrictionTypes = t('Primary Friction Types');
  strings.inferredSatisfaction = t('Inferred Satisfaction (model-estimated)');
  strings.suggestedQwenMdAdditions = t('Suggested QWEN.md Additions');
  strings.copyToQwenMd = t(
    'Just copy this into Qwen Code to add it to your QWEN.md.',
  );
  strings.copyAllChecked = t('Copy All Checked');
  strings.copiedAll = t('Copied All!');
  strings.whyForYou = t('Why for you:');
  strings.pasteIntoQwenCode = t('Paste into Qwen Code:');
  strings.gettingStarted = t('Getting started:');
  strings.keyPattern = t('Key pattern:');
  strings.exportCard = t('Export Card');
  strings.lightTheme = t('Light Theme');
  strings.darkTheme = t('Dark Theme');
  strings.noDataAvailable = t('No insight data available');
  strings.seeMoreImpressive = t('Impressive Things You Did →');
  strings.seeMoreFriction = t('Where Things Go Wrong →');
  strings.seeMoreFeatures = t('Features to Try →');
  strings.seeMoreHorizon = t('On the Horizon →');

  // Store the output language for LLM prompts
  strings['outputLanguage'] = outputLang;

  return strings;
}

export const insightCommand: SlashCommand = {
  name: 'insight',
  get description() {
    return t(
      'generate personalized programming insights from your chat history',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext) => {
    try {
      // Get user language settings
      const outputLangSetting =
        context.services.settings?.merged?.general?.outputLanguage || 'auto';
      const outputLang = resolveOutputLanguage(outputLangSetting);
      const outputLangName = getLanguageNameFromLocale(outputLang as string);

      // Build localized strings for the report
      const localizedStrings = buildLocalizedStrings(outputLangSetting);

      context.ui.setDebugMessage(t('Generating insights...'));

      const projectsDir = join(os.homedir(), '.qwen', 'projects');
      if (!context.services.config) {
        throw new Error('Config service is not available');
      }
      const insightGenerator = new StaticInsightGenerator(
        context.services.config,
      );

      const updateProgress = (
        stage: string,
        progress: number,
        detail?: string,
      ) => {
        const progressItem: HistoryItemInsightProgress = {
          type: MessageType.INSIGHT_PROGRESS,
          progress: {
            stage,
            progress,
            detail,
          },
        };
        context.ui.setPendingItem(progressItem);
      };

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('This may take a couple minutes. Sit tight!'),
        },
        Date.now(),
      );

      // Show language indicator message
      const langIndicatorMsg = t('Generating insights in {{language}}...', {
        language: outputLangName,
      });
      updateProgress(langIndicatorMsg, 0);

      // Generate the static insight HTML file
      const outputPath = await insightGenerator.generateStaticInsight(
        projectsDir,
        updateProgress,
        localizedStrings,
      );

      // Clear pending item
      context.ui.setPendingItem(null);

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Insight report generated successfully!'),
        },
        Date.now(),
      );

      // Open the file in the default browser
      try {
        await open(outputPath);

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Opening insights in your browser: {{path}}', {
              path: outputPath,
            }),
          },
          Date.now(),
        );
      } catch (browserError) {
        logger.error('Failed to open browser automatically:', browserError);

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Insights generated at: {{path}}. Please open this file in your browser.',
              {
                path: outputPath,
              },
            ),
          },
          Date.now(),
        );
      }

      context.ui.setDebugMessage(t('Insights ready.'));
    } catch (error) {
      // Clear pending item on error
      context.ui.setPendingItem(null);

      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to generate insights: {{error}}', {
            error: (error as Error).message,
          }),
        },
        Date.now(),
      );

      logger.error('Insight generation error:', error);
    }
  },
};
