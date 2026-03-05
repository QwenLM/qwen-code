/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simple i18n system for the insight report.
 * Supports the same languages as the CLI: zh, ja, pt, ru, de, en
 */

export type SupportedLanguage = 'zh' | 'ja' | 'pt' | 'ru' | 'de' | 'en';

// Language name mapping for display
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  zh: '中文',
  ja: '日本語',
  pt: 'Português',
  ru: 'Русский',
  de: 'Deutsch',
  en: 'English',
};

// Map full language names to codes
const LANGUAGE_CODE_MAP: Record<string, SupportedLanguage> = {
  chinese: 'zh',
  japanese: 'ja',
  portuguese: 'pt',
  russian: 'ru',
  german: 'de',
  english: 'en',
  // Also support direct codes
  zh: 'zh',
  ja: 'ja',
  pt: 'pt',
  ru: 'ru',
  de: 'de',
  en: 'en',
};

/**
 * Normalize a language string to a supported language code.
 */
export function normalizeLanguage(language: string): SupportedLanguage {
  const lowered = language.toLowerCase();
  return LANGUAGE_CODE_MAP[lowered] ?? 'en';
}

// Translation dictionary type
type TranslationDict = Record<string, string>;

// All translations
const translations: Record<SupportedLanguage, TranslationDict> = {
  en: {
    // Header
    title: 'Qwen Code Insights',
    subtitle_messages: '{{messages}} messages across {{sessions}} sessions',
    subtitle_default: 'Your personalized coding journey and patterns',
    export_card: 'Export Card',
    light_theme: 'Light Theme',
    dark_theme: 'Dark Theme',

    // Stats
    messages: 'Messages',
    lines: 'Lines',
    files: 'Files',
    days: 'Days',
    msgs_per_day: 'Msgs/Day',

    // At a Glance
    at_a_glance: 'At a Glance',
    whats_working: "What's working:",
    whats_hindering: "What's hindering you:",
    quick_wins: 'Quick wins to try:',
    ambitious_workflows: 'Ambitious workflows:',
    see_more_wins: 'Impressive Things You Did →',
    see_more_friction: 'Where Things Go Wrong →',
    see_more_features: 'Features to Try →',
    see_more_horizon: 'On the Horizon →',

    // Navigation
    nav_work: 'What You Work On',
    nav_usage: 'How You Use Qwen Code',
    nav_wins: 'Impressive Things',
    nav_friction: 'Where Things Go Wrong',
    nav_features: 'Features to Try',
    nav_patterns: 'New Usage Patterns',
    nav_horizon: 'On the Horizon',

    // Sections
    section_work: 'What You Work On',
    section_usage: 'How You Use Qwen Code',
    section_wins: 'Impressive Things You Did',
    section_friction: 'Where Things Go Wrong',
    section_features: 'Existing Qwen Code Features to Try',
    section_patterns: 'New Ways to Use Qwen Code',
    section_horizon: 'On the Horizon',

    // Project Areas
    sessions: 'sessions',
    what_you_wanted: 'What You Wanted',
    top_tools_used: 'Top Tools Used',

    // Interaction Style
    key_pattern: 'Key pattern:',

    // Charts
    what_helped_most: "What Helped Most (Qwen's Capabilities)",
    outcomes: 'Outcomes',
    primary_friction_types: 'Primary Friction Types',
    inferred_satisfaction: 'Inferred Satisfaction (model-estimated)',

    // Outcome labels
    fully_achieved: 'Fully Achieved',
    mostly_achieved: 'Mostly Achieved',
    partially_achieved: 'Partially Achieved',
    not_achieved: 'Not Achieved',
    unclear: 'Unclear',

    // Friction labels
    misunderstood_request: 'Misunderstood Request',
    wrong_approach: 'Wrong Approach',
    buggy_code: 'Buggy Code',
    user_rejected_action: 'User Rejected',
    excessive_changes: 'Excessive Changes',

    // Satisfaction labels
    happy: 'Happy',
    satisfied: 'Satisfied',
    likely_satisfied: 'Likely Satisfied',
    dissatisfied: 'Dissatisfied',
    frustrated: 'Frustrated',

    // Success labels
    fast_accurate_search: 'Fast Search',
    correct_code_edits: 'Correct Edits',
    good_explanations: 'Good Explanations',
    proactive_help: 'Proactive Help',
    multi_file_changes: 'Multi-file Changes',
    good_debugging: 'Good Debugging',

    // Improvements
    suggested_qwen_md: 'Suggested QWEN.md Additions',
    qwen_md_hint: 'Just copy this into Qwen Code to add it to your QWEN.md.',
    copy_all_checked: 'Copy All Checked ({{count}})',
    copied_all: 'Copied All!',
    why: 'Why for you:',
    features_hint: "Just copy this into Qwen Code and it'll set it up for you.",
    patterns_hint:
      "Just copy this into Qwen Code and it'll walk you through it.",
    paste_into_qwen: 'Paste into Qwen Code:',
    getting_started: 'Getting started:',

    // Copy button
    copy: 'Copy',
    copied: 'Copied!',

    // Memorable Moment
    memorable_moment: 'Memorable Moment',
  },

  zh: {
    // Header
    title: 'Qwen Code 洞察报告',
    subtitle_messages: '在 {{sessions}} 个会话中发送了 {{messages}} 条消息',
    subtitle_default: '您的个性化编程之旅和模式分析',
    export_card: '导出卡片',
    light_theme: '浅色主题',
    dark_theme: '深色主题',

    // Stats
    messages: '消息数',
    lines: '代码行数',
    files: '文件数',
    days: '天数',
    msgs_per_day: '日均消息',

    // At a Glance
    at_a_glance: '概览',
    whats_working: '进展顺利：',
    whats_hindering: '遇到的障碍：',
    quick_wins: '快速改进建议：',
    ambitious_workflows: '进阶工作流：',
    see_more_wins: '您的出色表现 →',
    see_more_friction: '问题所在 →',
    see_more_features: '推荐功能 →',
    see_more_horizon: '未来展望 →',

    // Navigation
    nav_work: '您的工作内容',
    nav_usage: '您如何使用 Qwen Code',
    nav_wins: '出色表现',
    nav_friction: '问题所在',
    nav_features: '推荐功能',
    nav_patterns: '新的使用方式',
    nav_horizon: '未来展望',

    // Sections
    section_work: '您的工作内容',
    section_usage: '您如何使用 Qwen Code',
    section_wins: '您的出色表现',
    section_friction: '问题所在',
    section_features: 'Qwen Code 现有功能推荐',
    section_patterns: 'Qwen Code 新用法',
    section_horizon: '未来展望',

    // Project Areas
    sessions: '个会话',
    what_you_wanted: '您的目标',
    top_tools_used: '常用工具',

    // Interaction Style
    key_pattern: '关键模式：',

    // Charts
    what_helped_most: '最有帮助的能力',
    outcomes: '结果',
    primary_friction_types: '主要问题类型',
    inferred_satisfaction: '推断满意度（模型估算）',

    // Outcome labels
    fully_achieved: '完全达成',
    mostly_achieved: '基本达成',
    partially_achieved: '部分达成',
    not_achieved: '未达成',
    unclear: '不明确',

    // Friction labels
    misunderstood_request: '理解偏差',
    wrong_approach: '方法错误',
    buggy_code: '代码缺陷',
    user_rejected_action: '用户拒绝',
    excessive_changes: '过度修改',

    // Satisfaction labels
    happy: '满意',
    satisfied: '认可',
    likely_satisfied: '可能满意',
    dissatisfied: '不满意',
    frustrated: '受挫',

    // Success labels
    fast_accurate_search: '快速搜索',
    correct_code_edits: '正确编辑',
    good_explanations: '清晰解释',
    proactive_help: '主动帮助',
    multi_file_changes: '多文件修改',
    good_debugging: '有效调试',

    // Improvements
    suggested_qwen_md: '建议添加到 QWEN.md',
    qwen_md_hint: '将此复制到 Qwen Code 以添加到您的 QWEN.md。',
    copy_all_checked: '复制所有选中项 ({{count}})',
    copied_all: '已全部复制！',
    why: '对您的价值：',
    features_hint: '将此复制到 Qwen Code，它会为您自动配置。',
    patterns_hint: '将此复制到 Qwen Code，它会引导您完成设置。',
    paste_into_qwen: '粘贴到 Qwen Code：',
    getting_started: '开始使用：',

    // Copy button
    copy: '复制',
    copied: '已复制！',

    // Memorable Moment
    memorable_moment: '精彩瞬间',
  },

  ja: {
    // Header
    title: 'Qwen Code インサイト',
    subtitle_messages: '{{sessions}}セッションで{{messages}}件のメッセージ',
    subtitle_default: 'あなたのパーソナライズされたコーディングの旅とパターン',
    export_card: 'カードをエクスポート',
    light_theme: 'ライトテーマ',
    dark_theme: 'ダークテーマ',

    // Stats
    messages: 'メッセージ',
    lines: '行数',
    files: 'ファイル',
    days: '日数',
    msgs_per_day: '1日あたり',

    // At a Glance
    at_a_glance: '概要',
    whats_working: 'うまくいっていること：',
    whats_hindering: '障害となっていること：',
    quick_wins: 'すぐに試せる改善：',
    ambitious_workflows: 'より高度なワークフロー：',
    see_more_wins: 'あなたの成果 →',
    see_more_friction: '問題点 →',
    see_more_features: '試すべき機能 →',
    see_more_horizon: '今後の展望 →',

    // Navigation
    nav_work: '作業内容',
    nav_usage: 'Qwen Codeの使い方',
    nav_wins: 'あなたの成果',
    nav_friction: '問題点',
    nav_features: '試すべき機能',
    nav_patterns: '新しい使い方',
    nav_horizon: '今後の展望',

    // Sections
    section_work: '作業内容',
    section_usage: 'Qwen Codeの使い方',
    section_wins: 'あなたの成果',
    section_friction: '問題点',
    section_features: 'Qwen Codeの機能を試す',
    section_patterns: 'Qwen Codeの新しい使い方',
    section_horizon: '今後の展望',

    // Project Areas
    sessions: 'セッション',
    what_you_wanted: 'あなたの目標',
    top_tools_used: '使用ツール',

    // Interaction Style
    key_pattern: '主要なパターン：',

    // Charts
    what_helped_most: '最も役立った機能',
    outcomes: '結果',
    primary_friction_types: '主な問題タイプ',
    inferred_satisfaction: '推定満足度（モデル推定）',

    // Outcome labels
    fully_achieved: '完全達成',
    mostly_achieved: 'ほぼ達成',
    partially_achieved: '部分的達成',
    not_achieved: '未達成',
    unclear: '不明',

    // Friction labels
    misunderstood_request: 'リクエスト誤解',
    wrong_approach: 'アプローチ誤り',
    buggy_code: 'バグありコード',
    user_rejected_action: 'ユーザー拒否',
    excessive_changes: '過度な変更',

    // Satisfaction labels
    happy: '満足',
    satisfied: '良かった',
    likely_satisfied: 'たぶん満足',
    dissatisfied: '不満',
    frustrated: 'フラストレーション',

    // Success labels
    fast_accurate_search: '高速検索',
    correct_code_edits: '正確な編集',
    good_explanations: '良い説明',
    proactive_help: '積極的な支援',
    multi_file_changes: '複数ファイル変更',
    good_debugging: '効果的なデバッグ',

    // Improvements
    suggested_qwen_md: 'QWEN.mdへの追加提案',
    qwen_md_hint: 'これをQwen CodeにコピーしてQWEN.mdに追加してください。',
    copy_all_checked: '選択項目をすべてコピー ({{count}})',
    copied_all: 'すべてコピーしました！',
    why: 'あなたにとっての価値：',
    features_hint: 'これをQwen Codeにコピーすると自動的に設定されます。',
    patterns_hint: 'これをQwen Codeにコピーするとガイドが表示されます。',
    paste_into_qwen: 'Qwen Codeに貼り付け：',
    getting_started: '始め方：',

    // Copy button
    copy: 'コピー',
    copied: 'コピーしました！',

    // Memorable Moment
    memorable_moment: '思い出',
  },

  pt: {
    // Header
    title: 'Insights do Qwen Code',
    subtitle_messages: '{{messages}} mensagens em {{sessions}} sessões',
    subtitle_default: 'Sua jornada de programação personalizada e padrões',
    export_card: 'Exportar Cartão',
    light_theme: 'Tema Claro',
    dark_theme: 'Tema Escuro',

    // Stats
    messages: 'Mensagens',
    lines: 'Linhas',
    files: 'Arquivos',
    days: 'Dias',
    msgs_per_day: 'Msgs/Dia',

    // At a Glance
    at_a_glance: 'Visão Geral',
    whats_working: 'O que está funcionando:',
    whats_hindering: 'O que está atrapalhando:',
    quick_wins: 'Vitórias rápidas:',
    ambitious_workflows: 'Fluxos de trabalho ambiciosos:',
    see_more_wins: 'Suas Conquistas →',
    see_more_friction: 'Onde as Coisas Dão Errado →',
    see_more_features: 'Recursos para Experimentar →',
    see_more_horizon: 'No Horizonte →',

    // Navigation
    nav_work: 'O Que Você Trabalha',
    nav_usage: 'Como Você Usa o Qwen Code',
    nav_wins: 'Suas Conquistas',
    nav_friction: 'Onde as Coisas Dão Errado',
    nav_features: 'Recursos para Experimentar',
    nav_patterns: 'Novos Padrões de Uso',
    nav_horizon: 'No Horizonte',

    // Sections
    section_work: 'O Que Você Trabalha',
    section_usage: 'Como Você Usa o Qwen Code',
    section_wins: 'Suas Conquistas',
    section_friction: 'Onde as Coisas Dão Errado',
    section_features: 'Recursos do Qwen Code para Experimentar',
    section_patterns: 'Novas Formas de Usar o Qwen Code',
    section_horizon: 'No Horizonte',

    // Project Areas
    sessions: 'sessões',
    what_you_wanted: 'Seus Objetivos',
    top_tools_used: 'Ferramentas Mais Usadas',

    // Interaction Style
    key_pattern: 'Padrão principal:',

    // Charts
    what_helped_most: 'O Que Mais Ajudou',
    outcomes: 'Resultados',
    primary_friction_types: 'Tipos Principais de Atrito',
    inferred_satisfaction: 'Satisfação Inferida (estimada pelo modelo)',

    // Outcome labels
    fully_achieved: 'Totalmente Alcançado',
    mostly_achieved: 'Maiormente Alcançado',
    partially_achieved: 'Parcialmente Alcançado',
    not_achieved: 'Não Alcançado',
    unclear: 'Inclaro',

    // Friction labels
    misunderstood_request: 'Solicitação Mal Interpretada',
    wrong_approach: 'Abordagem Errada',
    buggy_code: 'Código com Bugs',
    user_rejected_action: 'Rejeitado pelo Usuário',
    excessive_changes: 'Mudanças Excessivas',

    // Satisfaction labels
    happy: 'Feliz',
    satisfied: 'Satisfeito',
    likely_satisfied: 'Provavelmente Satisfeito',
    dissatisfied: 'Insatisfeito',
    frustrated: 'Frustrado',

    // Success labels
    fast_accurate_search: 'Busca Rápida',
    correct_code_edits: 'Edições Corretas',
    good_explanations: 'Boas Explicações',
    proactive_help: 'Ajuda Proativa',
    multi_file_changes: 'Mudanças em Múltiplos Arquivos',
    good_debugging: 'Bom Debug',

    // Improvements
    suggested_qwen_md: 'Adições Sugeridas ao QWEN.md',
    qwen_md_hint: 'Copie isso para o Qwen Code para adicionar ao seu QWEN.md.',
    copy_all_checked: 'Copiar Todos Selecionados ({{count}})',
    copied_all: 'Todos Copiados!',
    why: 'Por que para você:',
    features_hint: 'Copie isso para o Qwen Code e ele configurará para você.',
    patterns_hint: 'Copie isso para o Qwen Code e ele guiará você.',
    paste_into_qwen: 'Cole no Qwen Code:',
    getting_started: 'Para começar:',

    // Copy button
    copy: 'Copiar',
    copied: 'Copiado!',

    // Memorable Moment
    memorable_moment: 'Momento Memorável',
  },

  ru: {
    // Header
    title: 'Инсайты Qwen Code',
    subtitle_messages: '{{messages}} сообщений в {{sessions}} сессиях',
    subtitle_default:
      'Ваш персонализированный путь программирования и паттерны',
    export_card: 'Экспортировать карточку',
    light_theme: 'Светлая тема',
    dark_theme: 'Тёмная тема',

    // Stats
    messages: 'Сообщения',
    lines: 'Строки',
    files: 'Файлы',
    days: 'Дней',
    msgs_per_day: 'Сообщений/день',

    // At a Glance
    at_a_glance: 'Обзор',
    whats_working: 'Что работает:',
    whats_hindering: 'Что мешает:',
    quick_wins: 'Быстрые победы:',
    ambitious_workflows: 'Амбициозные рабочие процессы:',
    see_more_wins: 'Ваши достижения →',
    see_more_friction: 'Где возникают проблемы →',
    see_more_features: 'Функции для尝试 →',
    see_more_horizon: 'На горизонте →',

    // Navigation
    nav_work: 'Над чем вы работаете',
    nav_usage: 'Как вы используете Qwen Code',
    nav_wins: 'Ваши достижения',
    nav_friction: 'Где возникают проблемы',
    nav_features: 'Функции для尝试',
    nav_patterns: 'Новые паттерны использования',
    nav_horizon: 'На горизонте',

    // Sections
    section_work: 'Над чем вы работаете',
    section_usage: 'Как вы используете Qwen Code',
    section_wins: 'Ваши достижения',
    section_friction: 'Где возникают проблемы',
    section_features: 'Функции Qwen Code для尝试',
    section_patterns: 'Новые способы использования Qwen Code',
    section_horizon: 'На горизонте',

    // Project Areas
    sessions: 'сессий',
    what_you_wanted: 'Ваши цели',
    top_tools_used: 'Используемые инструменты',

    // Interaction Style
    key_pattern: 'Ключевой паттерн:',

    // Charts
    what_helped_most: 'Что помогло больше всего',
    outcomes: 'Результаты',
    primary_friction_types: 'Основные типы проблем',
    inferred_satisfaction: 'Предполагаемое удовлетворение (оценка модели)',

    // Outcome labels
    fully_achieved: 'Полностью достигнуто',
    mostly_achieved: 'В основном достигнуто',
    partially_achieved: 'Частично достигнуто',
    not_achieved: 'Не достигнуто',
    unclear: 'Неясно',

    // Friction labels
    misunderstood_request: 'Непонятный запрос',
    wrong_approach: 'Неверный подход',
    buggy_code: 'Ошибочный код',
    user_rejected_action: 'Отклонено пользователем',
    excessive_changes: 'Чрезмерные изменения',

    // Satisfaction labels
    happy: 'Доволен',
    satisfied: 'Удовлетворён',
    likely_satisfied: 'Вероятно доволен',
    dissatisfied: 'Неудовлетворён',
    frustrated: 'Разочарован',

    // Success labels
    fast_accurate_search: 'Быстрый поиск',
    correct_code_edits: 'Корректные правки',
    good_explanations: 'Хорошие объяснения',
    proactive_help: 'Проактивная помощь',
    multi_file_changes: 'Изменения в нескольких файлах',
    good_debugging: 'Хорошая отладка',

    // Improvements
    suggested_qwen_md: 'Предложения для QWEN.md',
    qwen_md_hint: 'Скопируйте это в Qwen Code, чтобы добавить в ваш QWEN.md.',
    copy_all_checked: 'Копировать все выбранные ({{count}})',
    copied_all: 'Все скопировано!',
    why: 'Почему для вас:',
    features_hint: 'Скопируйте это в Qwen Code, и он настроит всё за вас.',
    patterns_hint:
      'Скопируйте это в Qwen Code, и он проведёт вас через процесс.',
    paste_into_qwen: 'Вставить в Qwen Code:',
    getting_started: 'Как начать:',

    // Copy button
    copy: 'Копировать',
    copied: 'Скопировано!',

    // Memorable Moment
    memorable_moment: 'Запоминающийся момент',
  },

  de: {
    // Header
    title: 'Qwen Code Einblicke',
    subtitle_messages: '{{messages}} Nachrichten in {{sessions}} Sitzungen',
    subtitle_default: 'Ihre personalisierte Programmierreise und Muster',
    export_card: 'Karte exportieren',
    light_theme: 'Helles Design',
    dark_theme: 'Dunkles Design',

    // Stats
    messages: 'Nachrichten',
    lines: 'Zeilen',
    files: 'Dateien',
    days: 'Tage',
    msgs_per_day: 'Nachr./Tag',

    // At a Glance
    at_a_glance: 'Auf einen Blick',
    whats_working: 'Was funktioniert:',
    whats_hindering: 'Was hindert Sie:',
    quick_wins: 'Schnelle Erfolge:',
    ambitious_workflows: 'Ambitionierte Workflows:',
    see_more_wins: 'Ihre Erfolge →',
    see_more_friction: 'Wo es Probleme gibt →',
    see_more_features: 'Funktionen zum Ausprobieren →',
    see_more_horizon: 'Am Horizont →',

    // Navigation
    nav_work: 'Woran Sie arbeiten',
    nav_usage: 'Wie Sie Qwen Code nutzen',
    nav_wins: 'Ihre Erfolge',
    nav_friction: 'Wo es Probleme gibt',
    nav_features: 'Funktionen zum Ausprobieren',
    nav_patterns: 'Neue Nutzungsmuster',
    nav_horizon: 'Am Horizont',

    // Sections
    section_work: 'Woran Sie arbeiten',
    section_usage: 'Wie Sie Qwen Code nutzen',
    section_wins: 'Ihre Erfolge',
    section_friction: 'Wo es Probleme gibt',
    section_features: 'Qwen Code Funktionen zum Ausprobieren',
    section_patterns: 'Neue Möglichkeiten, Qwen Code zu nutzen',
    section_horizon: 'Am Horizont',

    // Project Areas
    sessions: 'Sitzungen',
    what_you_wanted: 'Ihre Ziele',
    top_tools_used: 'Meistgenutzte Tools',

    // Interaction Style
    key_pattern: 'Hauptmuster:',

    // Charts
    what_helped_most: 'Was am meisten geholfen hat',
    outcomes: 'Ergebnisse',
    primary_friction_types: 'Hauptproblemtypen',
    inferred_satisfaction: 'Geschätzte Zufriedenheit (Modell-Schätzung)',

    // Outcome labels
    fully_achieved: 'Vollständig erreicht',
    mostly_achieved: 'Größtenteils erreicht',
    partially_achieved: 'Teilweise erreicht',
    not_achieved: 'Nicht erreicht',
    unclear: 'Unklar',

    // Friction labels
    misunderstood_request: 'Missverstandene Anfrage',
    wrong_approach: 'Falscher Ansatz',
    buggy_code: 'Fehlerhafter Code',
    user_rejected_action: 'Vom Benutzer abgelehnt',
    excessive_changes: 'Übermäßige Änderungen',

    // Satisfaction labels
    happy: 'Glücklich',
    satisfied: 'Zufrieden',
    likely_satisfied: 'Wahrscheinlich zufrieden',
    dissatisfied: 'Unzufrieden',
    frustrated: 'Frustriert',

    // Success labels
    fast_accurate_search: 'Schnelle Suche',
    correct_code_edits: 'Korrekte Bearbeitungen',
    good_explanations: 'Gute Erklärungen',
    proactive_help: 'Proaktive Hilfe',
    multi_file_changes: 'Mehrere Dateien geändert',
    good_debugging: 'Gutes Debugging',

    // Improvements
    suggested_qwen_md: 'Vorschläge für QWEN.md',
    qwen_md_hint:
      'Kopieren Sie dies in Qwen Code, um es zu Ihrer QWEN.md hinzuzufügen.',
    copy_all_checked: 'Alle ausgewählten kopieren ({{count}})',
    copied_all: 'Alle kopiert!',
    why: 'Warum für Sie:',
    features_hint:
      'Kopieren Sie dies in Qwen Code und es wird für Sie eingerichtet.',
    patterns_hint:
      'Kopieren Sie dies in Qwen Code und es führt Sie durch den Prozess.',
    paste_into_qwen: 'In Qwen Code einfügen:',
    getting_started: 'Erste Schritte:',

    // Copy button
    copy: 'Kopieren',
    copied: 'Kopiert!',

    // Memorable Moment
    memorable_moment: 'Denkwürdiger Moment',
  },
};

/**
 * Get a translation for a key in the specified language.
 * Falls back to English if the key is not found in the specified language.
 */
export function t(
  key: string,
  language: SupportedLanguage = 'en',
  params?: Record<string, string | number>,
): string {
  const langTranslations = translations[language] || translations.en;
  let text = langTranslations[key] || translations.en[key] || key;

  // Interpolate parameters
  if (params) {
    text = text.replace(/\{\{(\w+)\}\}/g, (_, paramKey) => String(params[paramKey] ?? `{{${paramKey}}}`));
  }

  return text;
}

/**
 * Get the current language from the insight data.
 */
export function getLanguageFromData(language?: string): SupportedLanguage {
  if (!language) return 'en';
  return normalizeLanguage(language);
}
