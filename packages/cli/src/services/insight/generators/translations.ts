/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SupportedLanguage } from '../../i18n/index.js';

export interface InsightTranslations {
  // Header
  title: string;
  headerTitle: string;
  headerSubtitle: string;
  exportCard: string;
  lightTheme: string;
  darkTheme: string;
  
  // At a Glance
  atAGlance: string;
  whatsWorking: string;
  whatsHindering: string;
  quickWins: string;
  ambitiousWorkflows: string;
  seeMore: string;
  
  // Navigation
  navWork: string;
  navUsage: string;
  navWins: string;
  navFriction: string;
  navFeatures: string;
  navPatterns: string;
  navHorizon: string;
  
  // Section titles
  sectionWork: string;
  sectionUsage: string;
  sectionWins: string;
  sectionFriction: string;
  sectionFeatures: string;
  sectionPatterns: string;
  sectionHorizon: string;
  
  // What You Work On
  whatYouWorkOn: string;
  sessions: string;
  
  // How You Use
  howYouUse: string;
  topToolsUsed: string;
  whatYouWanted: string;
  
  // Impressive Workflows
  impressiveWorkflows: string;
  primarySuccess: string;
  outcomes: string;
  
  // Friction Points
  whereThingsGoWrong: string;
  frictionIntro: string;
  
  // Features to Try
  featuresToTry: string;
  
  // Usage Patterns
  newUsagePatterns: string;
  
  // On the Horizon
  onTheHorizon: string;
  
  // Memorable Moment
  memorableMoment: string;
  
  // Stats
  totalMessages: string;
  totalSessions: string;
  totalHours: string;
  currentStreak: string;
  longestStreak: string;
  longestSession: string;
  mostActiveHour: string;
  linesAdded: string;
  linesRemoved: string;
  filesChanged: string;
  
  // Copy button
  copy: string;
  copied: string;
  
  // Export
  exportCard: string;
  
  // No data
  noData: string;
}

// English translations (default)
const en: InsightTranslations = {
  title: 'Qwen Code Insights',
  headerTitle: 'Qwen Code Insights',
  headerSubtitle: 'Your personalized coding journey and patterns',
  exportCard: 'Export Card',
  lightTheme: 'Light Theme',
  darkTheme: 'Dark Theme',
  
  atAGlance: 'At a Glance',
  whatsWorking: "What's working:",
  whatsHindering: "What's hindering you:",
  quickWins: 'Quick wins to try:',
  ambitiousWorkflows: 'Ambitious workflows:',
  seeMore: '→',
  
  navWork: 'What You Work On',
  navUsage: 'How You Use Qwen Code',
  navWins: 'Impressive Things',
  navFriction: 'Where Things Go Wrong',
  navFeatures: 'Features to Try',
  navPatterns: 'New Usage Patterns',
  navHorizon: 'On the Horizon',
  
  sectionWork: 'What You Work On',
  sectionUsage: 'How You Use Qwen Code',
  sectionWins: 'Impressive Things You Did',
  sectionFriction: 'Where Things Go Wrong',
  sectionFeatures: 'Features to Try',
  sectionPatterns: 'New Usage Patterns',
  sectionHorizon: 'On the Horizon',
  
  whatYouWorkOn: 'What You Work On',
  sessions: 'sessions',
  
  howYouUse: 'How You Use Qwen Code',
  topToolsUsed: 'Top Tools Used',
  whatYouWanted: 'What You Wanted',
  
  impressiveWorkflows: 'Impressive Workflows',
  primarySuccess: 'Primary Success',
  outcomes: 'Outcomes',
  
  whereThingsGoWrong: 'Where Things Go Wrong',
  frictionIntro: 'Friction points identified:',
  
  featuresToTry: 'Features to Try',
  
  newUsagePatterns: 'New Usage Patterns',
  
  onTheHorizon: 'On the Horizon',
  
  memorableMoment: 'Memorable Moment',
  
  totalMessages: 'messages',
  totalSessions: 'sessions',
  totalHours: 'hours',
  currentStreak: 'Current streak',
  longestStreak: 'Longest streak',
  longestSession: 'Longest session',
  mostActiveHour: 'Most active hour',
  linesAdded: 'lines added',
  linesRemoved: 'lines removed',
  filesChanged: 'files changed',
  
  copy: 'Copy',
  copied: 'Copied!',
  
  exportCard: 'Export Card',
  
  noData: 'No insight data available',
};

// Chinese translations
const zh: InsightTranslations = {
  title: 'Qwen Code 洞察',
  headerTitle: 'Qwen Code 洞察',
  headerSubtitle: '您的个性化编程旅程和模式',
  exportCard: '导出卡片',
  lightTheme: '浅色主题',
  darkTheme: '深色主题',
  
  atAGlance: '一览',
  whatsWorking: '进展顺利：',
  whatsHindering: '阻碍因素：',
  quickWins: '快速尝试：',
  ambitiousWorkflows: '进阶工作流：',
  seeMore: '→',
  
  navWork: '工作内容',
  navUsage: '使用方式',
  navWins: '亮点成就',
  navFriction: '摩擦问题',
  navFeatures: '功能推荐',
  navPatterns: '使用模式',
  navHorizon: '未来展望',
  
  sectionWork: '工作内容',
  sectionUsage: '使用方式',
  sectionWins: '亮点成就',
  sectionFriction: '摩擦问题',
  sectionFeatures: '功能推荐',
  sectionPatterns: '使用模式',
  sectionHorizon: '未来展望',
  
  whatYouWorkOn: '工作内容',
  sessions: '次会话',
  
  howYouUse: '如何使用 Qwen Code',
  topToolsUsed: '常用工具',
  whatYouWanted: '目标诉求',
  
  impressiveWorkflows: '令人印象深刻的工作流',
  primarySuccess: '主要成功',
  outcomes: '结果',
  
  whereThingsGoWrong: '摩擦问题',
  frictionIntro: '已识别的摩擦点：',
  
  featuresToTry: '功能推荐',
  
  newUsagePatterns: '新的使用模式',
  
  onTheHorizon: '未来展望',
  
  memorableMoment: '难忘时刻',
  
  totalMessages: '条消息',
  totalSessions: '次会话',
  totalHours: '小时',
  currentStreak: '当前连续',
  longestStreak: '最长连续',
  longestSession: '最长会话',
  mostActiveHour: '最活跃时段',
  linesAdded: '行新增',
  linesRemoved: '行删除',
  filesChanged: '文件修改',
  
  copy: '复制',
  copied: '已复制！',
  
  exportCard: '导出卡片',
  
  noData: '暂无洞察数据',
};

// Japanese translations
const ja: InsightTranslations = {
  title: 'Qwen Code インサイト',
  headerTitle: 'Qwen Code インサイト',
  headerSubtitle: 'あなたのパーソナライズされたコーディングジャーニーとパターン',
  exportCard: 'カードをエクスポート',
  lightTheme: 'ライトテーマ',
  darkTheme: 'ダークテーマ',
  
  atAGlance: '一目でわかる',
  whatsWorking: 'うまくいっていること：',
  whatsHindering: '妨げになっていること：',
  quickWins: 'すぐに試せること：',
  ambitiousWorkflows: '野心的なワークフロー：',
  seeMore: '→',
  
  navWork: '取り組んでいること',
  navUsage: '使い方',
  navWins: '印象的なこと',
  navFriction: '問題点',
  navFeatures: '試す機能',
  navPatterns: '新しい使用パターン',
  navHorizon: '今後の展望',
  
  sectionWork: '取り組んでいること',
  sectionUsage: '使い方',
  sectionWins: '印象的なこと',
  sectionFriction: '問題点',
  sectionFeatures: '試す機能',
  sectionPatterns: '新しい使用パターン',
  sectionHorizon: '今後の展望',
  
  whatYouWorkOn: '取り組んでいること',
  sessions: 'セッション',
  
  howYouUse: 'Qwen Code の使い方',
  topToolsUsed: 'よく使うツール',
  whatYouWanted: '求めていたこと',
  
  impressiveWorkflows: '印象的なワークフロー',
  primarySuccess: '主な成功',
  outcomes: '結果',
  
  whereThingsGoWrong: '問題点',
  frictionIntro: '識別された摩擦点：',
  
  featuresToTry: '試す機能',
  
  newUsagePatterns: '新しい使用パターン',
  
  onTheHorizon: '今後の展望',
  
  memorableMoment: '思い出深い瞬間',
  
  totalMessages: 'メッセージ',
  totalSessions: 'セッション',
  totalHours: '時間',
  currentStreak: '現在のストリーク',
  longestStreak: '最長のストリーク',
  longestSession: '最長のセッション',
  mostActiveHour: '最もアクティブな時間',
  linesAdded: '行追加',
  linesRemoved: '行削除',
  filesChanged: 'ファイル変更',
  
  copy: 'コピー',
  copied: 'コピーしました！',
  
  exportCard: 'カードをエクスポート',
  
  noData: 'インサイトデータがありません',
};

// German translations
const de: InsightTranslations = {
  title: 'Qwen Code Einblicke',
  headerTitle: 'Qwen Code Einblicke',
  headerSubtitle: 'Ihre personalisierte Coding-Reise und Muster',
  exportCard: 'Karte exportieren',
  lightTheme: 'Helles Design',
  darkTheme: 'Dunkles Design',
  
  atAGlance: 'Auf einen Blick',
  whatsWorking: 'Was funktioniert:',
  whatsHindering: 'Was hindert Sie:',
  quickWins: 'Schnelle Erfolge:',
  ambitiousWorkflows: 'Ambitionierte Workflows:',
  seeMore: '→',
  
  navWork: 'Woran Sie arbeiten',
  navUsage: 'Wie Sie es verwenden',
  navWins: 'Beeindruckendes',
  navFriction: 'Probleme',
  navFeatures: 'Funktionen zum Ausprobieren',
  navPatterns: 'Neue Nutzungsmuster',
  navHorizon: 'Zukunftsaussichten',
  
  sectionWork: 'Woran Sie arbeiten',
  sectionUsage: 'Wie Sie es verwenden',
  sectionWins: 'Beeindruckendes',
  sectionFriction: 'Probleme',
  sectionFeatures: 'Funktionen zum Ausprobieren',
  sectionPatterns: 'Neue Nutzungsmuster',
  sectionHorizon: 'Zukunftsaussichten',
  
  whatYouWorkOn: 'Woran Sie arbeiten',
  sessions: 'Sitzungen',
  
  howYouUse: 'Wie Sie Qwen Code verwenden',
  topToolsUsed: 'Häufig verwendete Tools',
  whatYouWanted: 'Was Sie wollten',
  
  impressiveWorkflows: 'Beeindruckende Workflows',
  primarySuccess: 'Haupterfolg',
  outcomes: 'Ergebnisse',
  
  whereThingsGoWrong: 'Probleme',
  frictionIntro: 'Identifizierte Probleme:',
  
  featuresToTry: 'Funktionen zum Ausprobieren',
  
  newUsagePatterns: 'Neue Nutzungsmuster',
  
  onTheHorizon: 'Zukunftsaussichten',
  
  memorableMoment: 'Unvergesslicher Moment',
  
  totalMessages: 'Nachrichten',
  totalSessions: 'Sitzungen',
  totalHours: 'Stunden',
  currentStreak: 'Aktuelle Serie',
  longestStreak: 'Längste Serie',
  longestSession: 'Längste Sitzung',
  mostActiveHour: 'Aktivste Stunde',
  linesAdded: 'Zeilen hinzugefügt',
  linesRemoved: 'Zeilen entfernt',
  filesChanged: 'Dateien geändert',
  
  copy: 'Kopieren',
  copied: 'Kopiert!',
  
  exportCard: 'Karte exportieren',
  
  noData: 'Keine Insight-Daten verfügbar',
};

// Portuguese translations
const pt: InsightTranslations = {
  title: 'Qwen Code Insights',
  headerTitle: 'Qwen Code Insights',
  headerSubtitle: 'Sua jornada e padrões de codificação personalizados',
  exportCard: 'Exportar cartão',
  lightTheme: 'Tema claro',
  darkTheme: 'Tema escuro',
  
  atAGlance: 'De relance',
  whatsWorking: 'O que está funcionando:',
  whatsHindering: 'O que está atrapalhando:',
  quickWins: 'Vitórias rápidas:',
  ambitiousWorkflows: 'Fluxos ambiciosos:',
  seeMore: '→',
  
  navWork: 'Em que você trabalha',
  navUsage: 'Como você usa',
  navWins: 'Coisas impressionantes',
  navFriction: 'Problemas',
  navFeatures: 'Recursos para experimentar',
  navPatterns: 'Novos padrões de uso',
  navHorizon: 'No horizonte',
  
  sectionWork: 'Em que você trabalha',
  sectionUsage: 'Como você usa',
  sectionWins: 'Coisas impressionantes',
  sectionFriction: 'Problemas',
  sectionFeatures: 'Recursos para experimentar',
  sectionPatterns: 'Novos padrões de uso',
  sectionHorizon: 'No horizonte',
  
  whatYouWorkOn: 'Em que você trabalha',
  sessions: 'sessões',
  
  howYouUse: 'Como você usa o Qwen Code',
  topToolsUsed: 'Ferramentas mais usadas',
  whatYouWanted: 'O que você queria',
  
  impressiveWorkflows: 'Fluxos impressionantes',
  primarySuccess: 'Sucesso principal',
  outcomes: 'Resultados',
  
  whereThingsGoWrong: 'Problemas',
  frictionIntro: 'Pontos de atrito identificados:',
  
  featuresToTry: 'Recursos para experimentar',
  
  newUsagePatterns: 'Novos padrões de uso',
  
  onTheHorizon: 'No horizonte',
  
  memorableMoment: 'Momento memorável',
  
  totalMessages: 'mensagens',
  totalSessions: 'sessões',
  totalHours: 'horas',
  currentStreak: 'Sequência atual',
  longestStreak: 'Maior sequência',
  longestSession: 'Maior sessão',
  mostActiveHour: 'Hora mais ativa',
  linesAdded: 'linhas adicionadas',
  linesRemoved: 'linhas removidas',
  filesChanged: 'arquivos alterados',
  
  copy: 'Copiar',
  copied: 'Copiado!',
  
  exportCard: 'Exportar cartão',
  
  noData: 'Nenhum dado de insight disponível',
};

// Russian translations
const ru: InsightTranslations = {
  title: 'Qwen Code Инсайты',
  headerTitle: 'Qwen Code Инсайты',
  headerSubtitle: 'Ваше персонализированное путешествие в кодировании и шаблоны',
  exportCard: 'Экспортировать карточку',
  lightTheme: 'Светлая тема',
  darkTheme: 'Тёмная тема',
  
  atAGlance: 'Вкратце',
  whatsWorking: 'Что работает:',
  whatsHindering: 'Что мешает:',
  quickWins: 'Быстрые победы:',
  ambitiousWorkflows: 'Амбициозные рабочие процессы:',
  seeMore: '→',
  
  navWork: 'Над чем вы работаете',
  navUsage: 'Как вы используете',
  navWins: 'Впечатляющие вещи',
  navFriction: 'Проблемы',
  navFeatures: 'Функции для попробовать',
  navPatterns: 'Новые шаблоны использования',
  navHorizon: 'На горизонте',
  
  sectionWork: 'Над чем вы работаете',
  sectionUsage: 'Как вы используете',
  sectionWins: 'Впечатляющие вещи',
  sectionFriction: 'Проблемы',
  sectionFeatures: 'Функции для попробовать',
  sectionPatterns: 'Новые шаблоны использования',
  sectionHorizon: 'На горизонте',
  
  whatYouWorkOn: 'Над чем вы работаете',
  sessions: 'сессий',
  
  howYouUse: 'Как вы используете Qwen Code',
  topToolsUsed: 'Используемые инструменты',
  whatYouWanted: 'Что вы хотели',
  
  impressiveWorkflows: 'Впечатляющие рабочие процессы',
  primarySuccess: 'Основной успех',
  outcomes: 'Результаты',
  
  whereThingsGoWrong: 'Проблемы',
  frictionIntro: 'Выявленные проблемы:',
  
  featuresToTry: 'Функции для попробовать',
  
  newUsagePatterns: 'Новые шаблоны использования',
  
  onTheHorizon: 'На горизонте',
  
  memorableMoment: 'Запоминающийся момент',
  
  totalMessages: 'сообщений',
  totalSessions: 'сессий',
  totalHours: 'часов',
  currentStreak: 'Текущая серия',
  longestStreak: 'Самая длинная серия',
  longestSession: 'Самая длинная сессия',
  mostActiveHour: 'Самый активный час',
  linesAdded: 'строк добавлено',
  linesRemoved: 'строк удалено',
  filesChanged: 'файлов изменено',
  
  copy: 'Копировать',
  copied: 'Скопировано!',
  
  exportCard: 'Экспортировать карточку',
  
  noData: 'Нет данных инсайтов',
};

// Get translations for a language
export function getInsightTranslations(language: SupportedLanguage): InsightTranslations {
  switch (language) {
    case 'zh':
      return zh;
    case 'ja':
      return ja;
    case 'de':
      return de;
    case 'pt':
      return pt;
    case 'ru':
      return ru;
    case 'en':
    default:
      return en;
  }
}
