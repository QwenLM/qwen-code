/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Localization strings for the Insight HTML report.
 * These are static UI strings that need to be translated.
 * LLM-generated content is handled separately via prompt instructions.
 */

export type InsightLanguage = 'en' | 'zh' | 'ja' | 'pt' | 'ru' | 'de';

export interface InsightTranslations {
  // Header
  headerTitle: string;
  headerSubtitle: string;
  headerSubtitleFallback: string;

  // At a Glance section
  atAGlanceTitle: string;
  whatsWorking: string;
  whatsHindering: string;
  quickWins: string;
  ambitiousWorkflows: string;
  seeMore: string;

  // Navigation
  navWhatYouWorkOn: string;
  navHowYouUse: string;
  navImpressiveThings: string;
  navWhereThingsGoWrong: string;
  navFeaturesToTry: string;
  navNewUsagePatterns: string;
  navOnTheHorizon: string;

  // Stats
  statMessages: string;
  statLines: string;
  statFiles: string;
  statDays: string;
  statMsgsPerDay: string;

  // Section titles
  sectionWhatYouWorkOn: string;
  sectionHowYouUse: string;
  sectionImpressiveThings: string;
  sectionWhereThingsGoWrong: string;
  sectionFeaturesToTry: string;
  sectionNewWays: string;
  sectionOnTheHorizon: string;

  // Project areas
  sessions: string;

  // Charts
  chartWhatYouWanted: string;
  chartTopToolsUsed: string;
  chartWhatHelpedMost: string;
  chartOutcomes: string;
  chartPrimaryFriction: string;
  chartInferredSatisfaction: string;

  // Interaction style
  keyPattern: string;

  // Improvements
  suggestedQwenMdAdditions: string;
  copyAllChecked: string;
  copiedAll: string;
  whyForYou: string;
  pasteIntoQwenCode: string;

  // Future opportunities
  gettingStarted: string;

  // Export
  exportCard: string;
  lightTheme: string;
  darkTheme: string;

  // Misc
  messagesAcrossSessions: string;
}

const translations: Record<InsightLanguage, InsightTranslations> = {
  en: {
    // Header
    headerTitle: 'Qwen Code Insights',
    headerSubtitle: '{{messages}} messages across {{sessions}} sessions',
    headerSubtitleFallback: 'Your personalized coding journey and patterns',

    // At a Glance section
    atAGlanceTitle: 'At a Glance',
    whatsWorking: "What's working:",
    whatsHindering: "What's hindering you:",
    quickWins: 'Quick wins to try:',
    ambitiousWorkflows: 'Ambitious workflows:',
    seeMore: 'See more →',

    // Navigation
    navWhatYouWorkOn: 'What You Work On',
    navHowYouUse: 'How You Use Qwen Code',
    navImpressiveThings: 'Impressive Things',
    navWhereThingsGoWrong: 'Where Things Go Wrong',
    navFeaturesToTry: 'Features to Try',
    navNewUsagePatterns: 'New Usage Patterns',
    navOnTheHorizon: 'On the Horizon',

    // Stats
    statMessages: 'Messages',
    statLines: 'Lines',
    statFiles: 'Files',
    statDays: 'Days',
    statMsgsPerDay: 'Msgs/Day',

    // Section titles
    sectionWhatYouWorkOn: 'What You Work On',
    sectionHowYouUse: 'How You Use Qwen Code',
    sectionImpressiveThings: 'Impressive Things You Did',
    sectionWhereThingsGoWrong: 'Where Things Go Wrong',
    sectionFeaturesToTry: 'Existing Qwen Code Features to Try',
    sectionNewWays: 'New Ways to Use Qwen Code',
    sectionOnTheHorizon: 'On the Horizon',

    // Project areas
    sessions: 'sessions',

    // Charts
    chartWhatYouWanted: 'What You Wanted',
    chartTopToolsUsed: 'Top Tools Used',
    chartWhatHelpedMost: "What Helped Most (Qwen's Capabilities)",
    chartOutcomes: 'Outcomes',
    chartPrimaryFriction: 'Primary Friction Types',
    chartInferredSatisfaction: 'Inferred Satisfaction (model-estimated)',

    // Interaction style
    keyPattern: 'Key pattern:',

    // Improvements
    suggestedQwenMdAdditions: 'Suggested QWEN.md Additions',
    copyAllChecked: 'Copy All Checked ({{count}})',
    copiedAll: 'Copied All!',
    whyForYou: 'Why for you:',
    pasteIntoQwenCode: 'Paste into Qwen Code:',

    // Future opportunities
    gettingStarted: 'Getting started:',

    // Export
    exportCard: 'Export Card',
    lightTheme: 'Light Theme',
    darkTheme: 'Dark Theme',

    // Misc
    messagesAcrossSessions:
      '{{messages}} messages across {{sessions}} sessions',
  },

  zh: {
    // Header
    headerTitle: 'Qwen Code 洞察报告',
    headerSubtitle: '{{sessions}} 个会话中的 {{messages}} 条消息',
    headerSubtitleFallback: '您的个性化编程旅程和模式',

    // At a Glance section
    atAGlanceTitle: '概览',
    whatsWorking: '效果良好的方面：',
    whatsHindering: '阻碍因素：',
    quickWins: '快速改进建议：',
    ambitiousWorkflows: '进阶工作流：',
    seeMore: '查看详情 →',

    // Navigation
    navWhatYouWorkOn: '工作内容',
    navHowYouUse: '使用方式',
    navImpressiveThings: '精彩表现',
    navWhereThingsGoWrong: '问题所在',
    navFeaturesToTry: '推荐功能',
    navNewUsagePatterns: '新使用模式',
    navOnTheHorizon: '未来展望',

    // Stats
    statMessages: '消息数',
    statLines: '代码行数',
    statFiles: '文件数',
    statDays: '天数',
    statMsgsPerDay: '日均消息',

    // Section titles
    sectionWhatYouWorkOn: '您的工作内容',
    sectionHowYouUse: '您如何使用 Qwen Code',
    sectionImpressiveThings: '您的精彩表现',
    sectionWhereThingsGoWrong: '问题所在',
    sectionFeaturesToTry: '值得尝试的 Qwen Code 功能',
    sectionNewWays: '使用 Qwen Code 的新方式',
    sectionOnTheHorizon: '未来展望',

    // Project areas
    sessions: '个会话',

    // Charts
    chartWhatYouWanted: '您的目标',
    chartTopToolsUsed: '常用工具',
    chartWhatHelpedMost: '最有帮助的能力',
    chartOutcomes: '结果',
    chartPrimaryFriction: '主要摩擦类型',
    chartInferredSatisfaction: '推断满意度（模型估算）',

    // Interaction style
    keyPattern: '关键模式：',

    // Improvements
    suggestedQwenMdAdditions: '建议添加到 QWEN.md',
    copyAllChecked: '复制已选 ({{count}})',
    copiedAll: '已全部复制！',
    whyForYou: '为什么适合您：',
    pasteIntoQwenCode: '粘贴到 Qwen Code：',

    // Future opportunities
    gettingStarted: '入门指南：',

    // Export
    exportCard: '导出卡片',
    lightTheme: '浅色主题',
    darkTheme: '深色主题',

    // Misc
    messagesAcrossSessions: '{{sessions}} 个会话中的 {{messages}} 条消息',
  },

  ja: {
    // Header
    headerTitle: 'Qwen Code インサイト',
    headerSubtitle: '{{sessions}} セッションで {{messages}} 件のメッセージ',
    headerSubtitleFallback:
      'あなたのパーソナライズされたコーディングの旅とパターン',

    // At a Glance section
    atAGlanceTitle: '概要',
    whatsWorking: 'うまくいっていること：',
    whatsHindering: '妨げていること：',
    quickWins: 'すぐに試せる改善：',
    ambitiousWorkflows: '野心的なワークフロー：',
    seeMore: '詳細を見る →',

    // Navigation
    navWhatYouWorkOn: '取り組んだ内容',
    navHowYouUse: '使い方',
    navImpressiveThings: '素晴らしい成果',
    navWhereThingsGoWrong: '問題点',
    navFeaturesToTry: '試すべき機能',
    navNewUsagePatterns: '新しい使用パターン',
    navOnTheHorizon: '今後の展望',

    // Stats
    statMessages: 'メッセージ',
    statLines: '行数',
    statFiles: 'ファイル',
    statDays: '日数',
    statMsgsPerDay: '日平均メッセージ',

    // Section titles
    sectionWhatYouWorkOn: '取り組んだ内容',
    sectionHowYouUse: 'Qwen Code の使い方',
    sectionImpressiveThings: 'あなたの素晴らしい成果',
    sectionWhereThingsGoWrong: '問題点',
    sectionFeaturesToTry: '試すべき Qwen Code 機能',
    sectionNewWays: 'Qwen Code の新しい使い方',
    sectionOnTheHorizon: '今後の展望',

    // Project areas
    sessions: 'セッション',

    // Charts
    chartWhatYouWanted: 'あなたの目標',
    chartTopToolsUsed: 'よく使うツール',
    chartWhatHelpedMost: '最も役立った機能',
    chartOutcomes: '結果',
    chartPrimaryFriction: '主な摩擦タイプ',
    chartInferredSatisfaction: '推定満足度（モデル推定）',

    // Interaction style
    keyPattern: '主要パターン：',

    // Improvements
    suggestedQwenMdAdditions: 'QWEN.md への追加提案',
    copyAllChecked: '選択項目をコピー ({{count}})',
    copiedAll: 'コピー完了！',
    whyForYou: 'あなたにおすすめの理由：',
    pasteIntoQwenCode: 'Qwen Code に貼り付け：',

    // Future opportunities
    gettingStarted: '始め方：',

    // Export
    exportCard: 'カードをエクスポート',
    lightTheme: 'ライトテーマ',
    darkTheme: 'ダークテーマ',

    // Misc
    messagesAcrossSessions:
      '{{sessions}} セッションで {{messages}} 件のメッセージ',
  },

  pt: {
    // Header
    headerTitle: 'Insights do Qwen Code',
    headerSubtitle: '{{messages}} mensagens em {{sessions}} sessões',
    headerSubtitleFallback:
      'Sua jornada de programação personalizada e padrões',

    // At a Glance section
    atAGlanceTitle: 'Visão Geral',
    whatsWorking: 'O que está funcionando:',
    whatsHindering: 'O que está atrapalhando:',
    quickWins: 'Vitórias rápidas:',
    ambitiousWorkflows: 'Fluxos de trabalho ambiciosos:',
    seeMore: 'Ver mais →',

    // Navigation
    navWhatYouWorkOn: 'No Que Você Trabalha',
    navHowYouUse: 'Como Você Usa',
    navImpressiveThings: 'Coisas Impressionantes',
    navWhereThingsGoWrong: 'Onde as Coisas Dão Errado',
    navFeaturesToTry: 'Recursos para Experimentar',
    navNewUsagePatterns: 'Novos Padrões de Uso',
    navOnTheHorizon: 'No Horizonte',

    // Stats
    statMessages: 'Mensagens',
    statLines: 'Linhas',
    statFiles: 'Arquivos',
    statDays: 'Dias',
    statMsgsPerDay: 'Msgs/Dia',

    // Section titles
    sectionWhatYouWorkOn: 'No Que Você Trabalha',
    sectionHowYouUse: 'Como Você Usa o Qwen Code',
    sectionImpressiveThings: 'Coisas Impressionantes Que Você Fez',
    sectionWhereThingsGoWrong: 'Onde as Coisas Dão Errado',
    sectionFeaturesToTry: 'Recursos do Qwen Code para Experimentar',
    sectionNewWays: 'Novas Formas de Usar o Qwen Code',
    sectionOnTheHorizon: 'No Horizonte',

    // Project areas
    sessions: 'sessões',

    // Charts
    chartWhatYouWanted: 'O Que Você Queria',
    chartTopToolsUsed: 'Ferramentas Mais Usadas',
    chartWhatHelpedMost: 'O Que Mais Ajudou',
    chartOutcomes: 'Resultados',
    chartPrimaryFriction: 'Tipos de Fricção',
    chartInferredSatisfaction: 'Satisfação Inferida (estimada pelo modelo)',

    // Interaction style
    keyPattern: 'Padrão principal:',

    // Improvements
    suggestedQwenMdAdditions: 'Sugestões para QWEN.md',
    copyAllChecked: 'Copiar Selecionados ({{count}})',
    copiedAll: 'Copiados!',
    whyForYou: 'Por que para você:',
    pasteIntoQwenCode: 'Cole no Qwen Code:',

    // Future opportunities
    gettingStarted: 'Para começar:',

    // Export
    exportCard: 'Exportar Cartão',
    lightTheme: 'Tema Claro',
    darkTheme: 'Tema Escuro',

    // Misc
    messagesAcrossSessions: '{{messages}} mensagens em {{sessions}} sessões',
  },

  ru: {
    // Header
    headerTitle: 'Инсайты Qwen Code',
    headerSubtitle: '{{messages}} сообщений в {{sessions}} сессиях',
    headerSubtitleFallback:
      'Ваш персонализированный путь программирования и паттерны',

    // At a Glance section
    atAGlanceTitle: 'Обзор',
    whatsWorking: 'Что работает:',
    whatsHindering: 'Что мешает:',
    quickWins: 'Быстрые улучшения:',
    ambitiousWorkflows: 'Амбициозные рабочие процессы:',
    seeMore: 'Подробнее →',

    // Navigation
    navWhatYouWorkOn: 'Над чем вы работаете',
    navHowYouUse: 'Как вы используете',
    navImpressiveThings: 'Впечатляющие результаты',
    navWhereThingsGoWrong: 'Где возникают проблемы',
    navFeaturesToTry: 'Функции для尝试',
    navNewUsagePatterns: 'Новые паттерны использования',
    navOnTheHorizon: 'На горизонте',

    // Stats
    statMessages: 'Сообщений',
    statLines: 'Строк',
    statFiles: 'Файлов',
    statDays: 'Дней',
    statMsgsPerDay: 'Сообщ/День',

    // Section titles
    sectionWhatYouWorkOn: 'Над чем вы работаете',
    sectionHowYouUse: 'Как вы используете Qwen Code',
    sectionImpressiveThings: 'Ваши впечатляющие результаты',
    sectionWhereThingsGoWrong: 'Где возникают проблемы',
    sectionFeaturesToTry: 'Функции Qwen Code для尝试',
    sectionNewWays: 'Новые способы использования Qwen Code',
    sectionOnTheHorizon: 'На горизонте',

    // Project areas
    sessions: 'сессий',

    // Charts
    chartWhatYouWanted: 'Ваши цели',
    chartTopToolsUsed: 'Частые инструменты',
    chartWhatHelpedMost: 'Что помогло больше всего',
    chartOutcomes: 'Результаты',
    chartPrimaryFriction: 'Типы проблем',
    chartInferredSatisfaction: 'Удовлетворённость (оценка модели)',

    // Interaction style
    keyPattern: 'Ключевой паттерн:',

    // Improvements
    suggestedQwenMdAdditions: 'Предложения для QWEN.md',
    copyAllChecked: 'Копировать выбранные ({{count}})',
    copiedAll: 'Скопировано!',
    whyForYou: 'Почему для вас:',
    pasteIntoQwenCode: 'Вставить в Qwen Code:',

    // Future opportunities
    gettingStarted: 'Как начать:',

    // Export
    exportCard: 'Экспорт карточки',
    lightTheme: 'Светлая тема',
    darkTheme: 'Тёмная тема',

    // Misc
    messagesAcrossSessions: '{{messages}} сообщений в {{sessions}} сессиях',
  },

  de: {
    // Header
    headerTitle: 'Qwen Code Einblicke',
    headerSubtitle: '{{messages}} Nachrichten in {{sessions}} Sitzungen',
    headerSubtitleFallback: 'Ihre personalisierte Programmierreise und Muster',

    // At a Glance section
    atAGlanceTitle: 'Überblick',
    whatsWorking: 'Was funktioniert:',
    whatsHindering: 'Was hindert Sie:',
    quickWins: 'Schnelle Verbesserungen:',
    ambitiousWorkflows: 'Ambitionierte Workflows:',
    seeMore: 'Mehr anzeigen →',

    // Navigation
    navWhatYouWorkOn: 'Woran Sie arbeiten',
    navHowYouUse: 'Wie Sie nutzen',
    navImpressiveThings: 'Beeindruckende Ergebnisse',
    navWhereThingsGoWrong: 'Wo Probleme auftreten',
    navFeaturesToTry: 'Funktionen zum Ausprobieren',
    navNewUsagePatterns: 'Neue Nutzungsmuster',
    navOnTheHorizon: 'Am Horizont',

    // Stats
    statMessages: 'Nachrichten',
    statLines: 'Zeilen',
    statFiles: 'Dateien',
    statDays: 'Tage',
    statMsgsPerDay: 'Nachr/Tag',

    // Section titles
    sectionWhatYouWorkOn: 'Woran Sie arbeiten',
    sectionHowYouUse: 'Wie Sie Qwen Code nutzen',
    sectionImpressiveThings: 'Ihre beeindruckenden Ergebnisse',
    sectionWhereThingsGoWrong: 'Wo Probleme auftreten',
    sectionFeaturesToTry: 'Qwen Code Funktionen zum Ausprobieren',
    sectionNewWays: 'Neue Möglichkeiten, Qwen Code zu nutzen',
    sectionOnTheHorizon: 'Am Horizont',

    // Project areas
    sessions: 'Sitzungen',

    // Charts
    chartWhatYouWanted: 'Ihre Ziele',
    chartTopToolsUsed: 'Meistgenutzte Tools',
    chartWhatHelpedMost: 'Was am meisten half',
    chartOutcomes: 'Ergebnisse',
    chartPrimaryFriction: 'Hauptproblemtypen',
    chartInferredSatisfaction: 'Geschätzte Zufriedenheit (Modell)',

    // Interaction style
    keyPattern: 'Hauptmuster:',

    // Improvements
    suggestedQwenMdAdditions: 'Vorschläge für QWEN.md',
    copyAllChecked: 'Ausgewählte kopieren ({{count}})',
    copiedAll: 'Kopiert!',
    whyForYou: 'Warum für Sie:',
    pasteIntoQwenCode: 'In Qwen Code einfügen:',

    // Future opportunities
    gettingStarted: 'Erste Schritte:',

    // Export
    exportCard: 'Karte exportieren',
    lightTheme: 'Helles Thema',
    darkTheme: 'Dunkles Thema',

    // Misc
    messagesAcrossSessions:
      '{{messages}} Nachrichten in {{sessions}} Sitzungen',
  },
};

/**
 * Maps language names to language codes.
 */
function getLanguageCode(language: string | undefined): InsightLanguage {
  if (!language) return 'en';

  const lower = language.toLowerCase();
  if (lower.includes('zh') || lower.includes('chinese')) return 'zh';
  if (lower.includes('ja') || lower.includes('japanese')) return 'ja';
  if (lower.includes('pt') || lower.includes('portuguese')) return 'pt';
  if (lower.includes('ru') || lower.includes('russian')) return 'ru';
  if (lower.includes('de') || lower.includes('german')) return 'de';

  return 'en';
}

/**
 * Get translations for a specific language.
 */
export function getTranslations(
  language: string | undefined,
): InsightTranslations {
  const code = getLanguageCode(language);
  return translations[code] || translations['en'];
}

/**
 * Interpolate a translation string with parameters.
 */
export function interpolateTranslation(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = params[key];
    return value !== undefined ? String(value) : match;
  });
}
