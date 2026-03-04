/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Supported languages for the insight report
 */
export type InsightLanguage = 'en' | 'zh' | 'ru' | 'de' | 'ja' | 'pt';

/**
 * Translation strings for the insight report
 */
export interface InsightTranslations {
  // Header
  headerTitle: string;
  headerSubtitle: (messages: number, sessions: number) => string;
  headerSubtitleEmpty: string;

  // Stats
  statMessages: string;
  statLines: string;
  statFiles: string;
  statDays: string;
  statMsgsPerDay: string;

  // Navigation
  navWhatYouWorkOn: string;
  navHowYouUse: string;
  navImpressiveThings: string;
  navWhereThingsGoWrong: string;
  navFeaturesToTry: string;
  navNewUsagePatterns: string;
  navOnTheHorizon: string;

  // At a Glance
  atAGlanceTitle: string;
  glanceWhatsWorking: string;
  glanceWhatsHindering: string;
  glanceQuickWins: string;
  glanceAmbitiousWorkflows: string;
  seeMoreImpressive: string;
  seeMoreWrong: string;
  seeMoreFeatures: string;
  seeMoreHorizon: string;

  // Section titles
  sectionWhatYouWorkOn: string;
  sectionHowYouUse: string;
  sectionImpressiveThings: string;
  sectionWhereThingsGoWrong: string;
  sectionFeaturesToTry: string;
  sectionNewWays: string;
  sectionOnTheHorizon: string;

  // Project Areas
  sessionsCount: (count: number) => string;

  // Charts
  chartWhatYouWanted: string;
  chartTopToolsUsed: string;
  chartWhatHelpedMost: string;
  chartOutcomes: string;
  chartPrimaryFriction: string;
  chartInferredSatisfaction: string;

  // Interaction Style
  keyPattern: string;

  // Friction Points
  category: string;

  // Improvements
  suggestedQwenMdAdditions: string;
  qwenMdAdditionsHint: string;
  copyAllChecked: (count: number) => string;
  copiedAll: string;
  whyForYou: string;
  pasteIntoQwenCode: string;
  justCopyHint: string;
  justCopyHintPatterns: string;

  // Future Opportunities
  gettingStarted: string;

  // Export
  exportCard: string;
  lightTheme: string;
  darkTheme: string;

  // Copy button
  copy: string;
  copied: string;

  // No data
  noInsightData: string;

  // Session labels
  session: string;
}

/**
 * English translations
 */
const enTranslations: InsightTranslations = {
  // Header
  headerTitle: 'Qwen Code Insights',
  headerSubtitle: (messages, sessions) =>
    `${messages.toLocaleString()} messages across ${sessions.toLocaleString()} sessions`,
  headerSubtitleEmpty: 'Your personalized coding journey and patterns',

  // Stats
  statMessages: 'Messages',
  statLines: 'Lines',
  statFiles: 'Files',
  statDays: 'Days',
  statMsgsPerDay: 'Msgs/Day',

  // Navigation
  navWhatYouWorkOn: 'What You Work On',
  navHowYouUse: 'How You Use Qwen Code',
  navImpressiveThings: 'Impressive Things',
  navWhereThingsGoWrong: 'Where Things Go Wrong',
  navFeaturesToTry: 'Features to Try',
  navNewUsagePatterns: 'New Usage Patterns',
  navOnTheHorizon: 'On the Horizon',

  // At a Glance
  atAGlanceTitle: 'At a Glance',
  glanceWhatsWorking: "What's working:",
  glanceWhatsHindering: "What's hindering you:",
  glanceQuickWins: 'Quick wins to try:',
  glanceAmbitiousWorkflows: 'Ambitious workflows:',
  seeMoreImpressive: 'Impressive Things You Did →',
  seeMoreWrong: 'Where Things Go Wrong →',
  seeMoreFeatures: 'Features to Try →',
  seeMoreHorizon: 'On the Horizon →',

  // Section titles
  sectionWhatYouWorkOn: 'What You Work On',
  sectionHowYouUse: 'How You Use Qwen Code',
  sectionImpressiveThings: 'Impressive Things You Did',
  sectionWhereThingsGoWrong: 'Where Things Go Wrong',
  sectionFeaturesToTry: 'Existing Qwen Code Features to Try',
  sectionNewWays: 'New Ways to Use Qwen Code',
  sectionOnTheHorizon: 'On the Horizon',

  // Project Areas
  sessionsCount: (count) => `~${count} sessions`,

  // Charts
  chartWhatYouWanted: 'What You Wanted',
  chartTopToolsUsed: 'Top Tools Used',
  chartWhatHelpedMost: "What Helped Most (Qwen's Capabilities)",
  chartOutcomes: 'Outcomes',
  chartPrimaryFriction: 'Primary Friction Types',
  chartInferredSatisfaction: 'Inferred Satisfaction (model-estimated)',

  // Interaction Style
  keyPattern: 'Key pattern:',

  // Friction Points
  category: 'Category',

  // Improvements
  suggestedQwenMdAdditions: 'Suggested QWEN.md Additions',
  qwenMdAdditionsHint:
    'Just copy this into Qwen Code to add it to your QWEN.md.',
  copyAllChecked: (count) => `Copy All Checked (${count})`,
  copiedAll: 'Copied All!',
  whyForYou: 'Why for you:',
  pasteIntoQwenCode: 'Paste into Qwen Code:',
  justCopyHint: "Just copy this into Qwen Code and it'll set it up for you.",
  justCopyHintPatterns:
    "Just copy this into Qwen Code and it'll walk you through it.",

  // Future Opportunities
  gettingStarted: 'Getting started:',

  // Export
  exportCard: 'Export Card',
  lightTheme: 'Light Theme',
  darkTheme: 'Dark Theme',

  // Copy button
  copy: 'Copy',
  copied: 'Copied!',

  // No data
  noInsightData: 'No insight data available',

  // Session labels
  session: 'Session',
};

/**
 * Chinese translations
 */
const zhTranslations: InsightTranslations = {
  // Header
  headerTitle: 'Qwen Code 洞察报告',
  headerSubtitle: (messages, sessions) =>
    `${messages.toLocaleString()} 条消息，共 ${sessions.toLocaleString()} 个会话`,
  headerSubtitleEmpty: '您的个性化编程历程和模式',

  // Stats
  statMessages: '消息数',
  statLines: '代码行数',
  statFiles: '文件数',
  statDays: '天数',
  statMsgsPerDay: '日均消息',

  // Navigation
  navWhatYouWorkOn: '您的工作内容',
  navHowYouUse: '您如何使用 Qwen Code',
  navImpressiveThings: '您的精彩表现',
  navWhereThingsGoWrong: '问题所在',
  navFeaturesToTry: '推荐功能',
  navNewUsagePatterns: '新用法',
  navOnTheHorizon: '未来展望',

  // At a Glance
  atAGlanceTitle: '概览',
  glanceWhatsWorking: '运行良好的：',
  glanceWhatsHindering: '遇到的障碍：',
  glanceQuickWins: '快速改进建议：',
  glanceAmbitiousWorkflows: '高阶工作流：',
  seeMoreImpressive: '您的精彩表现 →',
  seeMoreWrong: '问题所在 →',
  seeMoreFeatures: '推荐功能 →',
  seeMoreHorizon: '未来展望 →',

  // Section titles
  sectionWhatYouWorkOn: '您的工作内容',
  sectionHowYouUse: '您如何使用 Qwen Code',
  sectionImpressiveThings: '您的精彩表现',
  sectionWhereThingsGoWrong: '问题所在',
  sectionFeaturesToTry: '推荐的 Qwen Code 功能',
  sectionNewWays: 'Qwen Code 新用法',
  sectionOnTheHorizon: '未来展望',

  // Project Areas
  sessionsCount: (count) => `约 ${count} 个会话`,

  // Charts
  chartWhatYouWanted: '您的目标',
  chartTopToolsUsed: '常用工具',
  chartWhatHelpedMost: '最有帮助的能力',
  chartOutcomes: '结果',
  chartPrimaryFriction: '主要问题类型',
  chartInferredSatisfaction: '推断的满意度（模型估算）',

  // Interaction Style
  keyPattern: '关键模式：',

  // Friction Points
  category: '类别',

  // Improvements
  suggestedQwenMdAdditions: '建议添加到 QWEN.md',
  qwenMdAdditionsHint: '复制到 Qwen Code 即可添加到您的 QWEN.md。',
  copyAllChecked: (count) => `复制全部选中 (${count})`,
  copiedAll: '已复制全部！',
  whyForYou: '为您推荐：',
  pasteIntoQwenCode: '粘贴到 Qwen Code：',
  justCopyHint: '复制到 Qwen Code，它会自动设置。',
  justCopyHintPatterns: '复制到 Qwen Code，它会引导您完成。',

  // Future Opportunities
  gettingStarted: '开始使用：',

  // Export
  exportCard: '导出卡片',
  lightTheme: '浅色主题',
  darkTheme: '深色主题',

  // Copy button
  copy: '复制',
  copied: '已复制！',

  // No data
  noInsightData: '无洞察数据',

  // Session labels
  session: '会话',
};

/**
 * All available translations
 */
const translations: Record<InsightLanguage, InsightTranslations> = {
  en: enTranslations,
  zh: zhTranslations,
  ru: enTranslations, // Fallback to English
  de: enTranslations, // Fallback to English
  ja: enTranslations, // Fallback to English
  pt: enTranslations, // Fallback to English
};

/**
 * Get translations for a specific language
 */
export function getTranslations(
  language: InsightLanguage = 'en',
): InsightTranslations {
  return translations[language] || translations['en'];
}

/**
 * Get the language name for display
 */
export function getLanguageDisplayName(language: InsightLanguage): string {
  const names: Record<InsightLanguage, string> = {
    en: 'English',
    zh: '中文',
    ru: 'Русский',
    de: 'Deutsch',
    ja: '日本語',
    pt: 'Português',
  };
  return names[language] || names['en'];
}
