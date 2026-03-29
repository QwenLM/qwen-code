/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

// Inline i18n translations for the insight HTML report
// These are used by the React components to render localized UI strings

export type Locale = string;

export interface Translations {
  [key: string]: string;
}

// Translation dictionaries for each supported language
const translations: Record<Locale, Translations> = {
  // English (default)
  en: {
    // Header
    'Qwen Code Insights': 'Qwen Code Insights',
    'messages across': 'messages across',
    sessions: 'sessions',
    'Your personalized coding journey and patterns':
      'Your personalized coding journey and patterns',

    // Stats
    Messages: 'Messages',
    Lines: 'Lines',
    Files: 'Files',
    Days: 'Days',
    'Msgs/Day': 'Msgs/Day',

    // Section titles (At a Glance)
    'At a Glance': 'At a Glance',
    "What's working": "What's working",
    "What's hindering you": "What's hindering you",
    'Quick wins to try': 'Quick wins to try',
    'Ambitious workflows': 'Ambitious workflows',
    'Impressive Things You Did →': 'Impressive Things You Did →',
    'Where Things Go Wrong →': 'Where Things Go Wrong →',
    'Features to Try →': 'Features to Try →',
    'On the Horizon →': 'On the Horizon →',

    // TOC
    'What You Work On': 'What You Work On',
    'How You Use Qwen Code': 'How You Use Qwen Code',
    'Impressive Things': 'Impressive Things',
    'Where Things Go Wrong': 'Where Things Go Wrong',
    'Features to Try': 'Features to Try',
    'New Usage Patterns': 'New Usage Patterns',
    'On the Horizon': 'On the Horizon',

    // Section headers
    'Existing Qwen Code Features to Try': 'Existing Qwen Code Features to Try',
    'New Ways to Use Qwen Code': 'New Ways to Use Qwen Code',

    // Charts
    'Active Hours': 'Active Hours',
    'Activity Heatmap': 'Activity Heatmap',
    'Showing past year of activity': 'Showing past year of activity',
    Less: 'Less',
    More: 'More',

    // Export
    'Export Card': 'Export Card',
    'Light Theme': 'Light Theme',
    'Dark Theme': 'Dark Theme',

    // QWEN.md section
    'Suggested QWEN.md Additions': 'Suggested QWEN.md Additions',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Just copy this into Qwen Code to add it to your QWEN.md.',
    'Copied All!': 'Copied All!',
    'Copy All Checked': 'Copy All Checked',

    // Misc
    'Key pattern:': 'Key pattern:',
    'Getting started:': 'Getting started:',
    'Paste into Qwen Code:': 'Paste into Qwen Code:',
    "Just copy this into Qwen Code and it'll set it up for you.":
      "Just copy this into Qwen Code and it'll set it up for you.",
    "Just copy this into Qwen Code and it'll walk you through it.":
      "Just copy this into Qwen Code and it'll walk you through it.",
    "What Helped Most (Qwen's Capabilities)":
      "What Helped Most (Qwen's Capabilities)",
    Outcomes: 'Outcomes',
    'Primary Friction Types': 'Primary Friction Types',
    'Inferred Satisfaction (model-estimated)':
      'Inferred Satisfaction (model-estimated)',
    'What You Wanted': 'What You Wanted',
    'Top Tools Used': 'Top Tools Used',
    Morning: 'Morning',
    Afternoon: 'Afternoon',
    Evening: 'Evening',
    Night: 'Night',
  },

  // Chinese
  zh: {
    'Qwen Code Insights': 'Qwen Code 洞察',
    'messages across': '条消息，共',
    sessions: '个会话',
    'Your personalized coding journey and patterns': '您的个性化编程旅程与模式',

    Messages: '消息',
    Lines: '代码行',
    Files: '文件',
    Days: '天',
    'Msgs/Day': '消息/天',

    'At a Glance': '概览',
    "What's working": '有效的方法',
    "What's hindering you": '阻碍因素',
    'Quick wins to try': '可尝试的快速优化',
    'Ambitious workflows': '雄心勃勃的工作流',
    'Impressive Things You Did →': '你做的令人印象深刻的事 →',
    'Where Things Go Wrong →': '问题出在哪里 →',
    'Features to Try →': '可尝试的功能 →',
    'On the Horizon →': '展望未来 →',

    'What You Work On': '你的工作内容',
    'How You Use Qwen Code': '你如何使用 Qwen Code',
    'Impressive Things': '令人印象深刻的事',
    'Where Things Go Wrong': '问题出在哪里',
    'Features to Try': '可尝试的功能',
    'New Usage Patterns': '新的使用模式',
    'On the Horizon': '展望未来',

    'Existing Qwen Code Features to Try': '可尝试的现有 Qwen Code 功能',
    'New Ways to Use Qwen Code': '使用 Qwen Code 的新方式',

    'Active Hours': '活跃时段',
    'Activity Heatmap': '活动热力图',
    'Showing past year of activity': '显示过去一年的活动',
    Less: '少',
    More: '多',

    'Export Card': '导出卡片',
    'Light Theme': '浅色主题',
    'Dark Theme': '深色主题',

    'Suggested QWEN.md Additions': '建议的 QWEN.md 补充',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      '只需将其复制到 Qwen Code 即可添加到你的 QWEN.md。',
    'Copied All!': '已全部复制！',
    'Copy All Checked': '复制所有已选项',

    'Key pattern:': '关键模式：',
    'Getting started:': '入门指南：',
    'Paste into Qwen Code:': '粘贴到 Qwen Code：',
    "Just copy this into Qwen Code and it'll set it up for you.":
      '只需将其复制到 Qwen Code，它会帮你设置。',
    "Just copy this into Qwen Code and it'll walk you through it.":
      '只需将其复制到 Qwen Code，它会引导你完成。',
    "What Helped Most (Qwen's Capabilities)": '最有帮助的（Qwen 的能力）',
    Outcomes: '结果',
    'Primary Friction Types': '主要摩擦类型',
    'Inferred Satisfaction (model-estimated)': '推断满意度（模型估计）',
    'What You Wanted': '你想要的',
    'Top Tools Used': '常用工具',
    Morning: '上午',
    Afternoon: '下午',
    Evening: '晚上',
    Night: '夜间',
  },

  // Russian
  ru: {
    'Qwen Code Insights': 'Аналитика Qwen Code',
    'messages across': 'сообщений в',
    sessions: 'сессиях',
    'Your personalized coding journey and patterns':
      'Ваш персональный путь кодирования и шаблоны',

    Messages: 'Сообщения',
    Lines: 'Строки',
    Files: 'Файлы',
    Days: 'Дни',
    'Msgs/Day': 'Сообщ./день',

    'At a Glance': 'Обзор',
    "What's working": 'Что работает',
    "What's hindering you": 'Что мешает',
    'Quick wins to try': 'Быстрые победы',
    'Ambitious workflows': 'Амбициозные рабочие процессы',
    'Impressive Things You Did →': 'Впечатляющие вещи →',
    'Where Things Go Wrong →': 'Где возникают проблемы →',
    'Features to Try →': 'Функции для пробы →',
    'On the Horizon →': 'На горизонте →',

    'What You Work On': 'Над чем вы работаете',
    'How You Use Qwen Code': 'Как вы используете Qwen Code',
    'Impressive Things': 'Впечатляющие вещи',
    'Where Things Go Wrong': 'Где возникают проблемы',
    'Features to Try': 'Функции для пробы',
    'New Usage Patterns': 'Новые шаблоны использования',
    'On the Horizon': 'На горизонте',

    'Existing Qwen Code Features to Try':
      'Существующие функции Qwen Code для пробы',
    'New Ways to Use Qwen Code': 'Новые способы использования Qwen Code',

    'Active Hours': 'Активные часы',
    'Activity Heatmap': 'Тепловая карта активности',
    'Showing past year of activity': 'Показывает активность за прошлый год',
    Less: 'Меньше',
    More: 'Больше',

    'Export Card': 'Экспорт карточки',
    'Light Theme': 'Светлая тема',
    'Dark Theme': 'Тёмная тема',

    'Suggested QWEN.md Additions': 'Рекомендуемые дополнения QWEN.md',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Просто скопируйте это в Qwen Code, чтобы добавить в QWEN.md.',
    'Copied All!': 'Всё скопировано!',
    'Copy All Checked': 'Копировать все отмеченные',

    'Key pattern:': 'Ключевой шаблон:',
    'Getting started:': 'Начало работы:',
    'Paste into Qwen Code:': 'Вставить в Qwen Code:',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'Просто скопируйте это в Qwen Code, и он настроит это для вас.',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'Просто скопируйте это в Qwen Code, и он проведёт вас через это.',
    "What Helped Most (Qwen's Capabilities)":
      'Что помогло больше всего (возможности Qwen)',
    Outcomes: 'Результаты',
    'Primary Friction Types': 'Основные типы трения',
    'Inferred Satisfaction (model-estimated)':
      'Расчётная удовлетворённость (оценка модели)',
    'What You Wanted': 'Что вы хотели',
    'Top Tools Used': 'Используемые инструменты',
    Morning: 'Утро',
    Afternoon: 'День',
    Evening: 'Вечер',
    Night: 'Ночь',
  },

  // German
  de: {
    'Qwen Code Insights': 'Qwen Code Einblicke',
    'messages across': 'Nachrichten in',
    sessions: 'Sitzungen',
    'Your personalized coding journey and patterns':
      'Ihre personalisierte Coding-Reise und Muster',

    Messages: 'Nachrichten',
    Lines: 'Zeilen',
    Files: 'Dateien',
    Days: 'Tage',
    'Msgs/Day': 'Nachr./Tag',

    'At a Glance': 'Auf einen Blick',
    "What's working": 'Was funktioniert',
    "What's hindering you": 'Was hindert Sie',
    'Quick wins to try': 'Schnelle Erfolge',
    'Ambitious workflows': 'Ambitionierte Workflows',
    'Impressive Things You Did →': 'Beeindruckende Dinge →',
    'Where Things Go Wrong →': 'Wo es schiefgeht →',
    'Features to Try →': 'Ausprobierbare Funktionen →',
    'On the Horizon →': 'Am Horizont →',

    'What You Work On': 'Woran Sie arbeiten',
    'How You Use Qwen Code': 'Wie Sie Qwen Code verwenden',
    'Impressive Things': 'Beeindruckende Dinge',
    'Where Things Go Wrong': 'Wo es schiefgeht',
    'Features to Try': 'Ausprobierbare Funktionen',
    'New Usage Patterns': 'Neue Nutzungsmuster',
    'On the Horizon': 'Am Horizont',

    'Existing Qwen Code Features to Try':
      'Vorhandene Qwen Code-Funktionen zum Ausprobieren',
    'New Ways to Use Qwen Code': 'Neue Wege, Qwen Code zu verwenden',

    'Active Hours': 'Aktive Stunden',
    'Activity Heatmap': 'Aktivitäts-Heatmap',
    'Showing past year of activity': 'Zeigt das vergangene Jahr der Aktivität',
    Less: 'Weniger',
    More: 'Mehr',

    'Export Card': 'Karte exportieren',
    'Light Theme': 'Helles Design',
    'Dark Theme': 'Dunkles Design',

    'Suggested QWEN.md Additions': 'Vorgeschlagene QWEN.md-Ergänzungen',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Kopieren Sie dies einfach in Qwen Code, um es zu QWEN.md hinzuzufügen.',
    'Copied All!': 'Alles kopiert!',
    'Copy All Checked': 'Alle markierten kopieren',

    'Key pattern:': 'Schlüsselmuster:',
    'Getting started:': 'Erste Schritte:',
    'Paste into Qwen Code:': 'In Qwen Code einfügen:',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'Kopieren Sie dies einfach in Qwen Code und es wird für Sie eingerichtet.',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'Kopieren Sie dies einfach in Qwen Code und es führt Sie durch.',
    "What Helped Most (Qwen's Capabilities)":
      'Was am meisten geholfen hat (Qwen-Funktionen)',
    Outcomes: 'Ergebnisse',
    'Primary Friction Types': 'Primäre Reibungspunkte',
    'Inferred Satisfaction (model-estimated)':
      'Abgeleitete Zufriedenheit (Modellschätzung)',
    'What You Wanted': 'Was Sie wollten',
    'Top Tools Used': 'Meistgenutzte Tools',
    Morning: 'Morgen',
    Afternoon: 'Nachmittag',
    Evening: 'Abend',
    Night: 'Nacht',
  },

  // Japanese
  ja: {
    'Qwen Code Insights': 'Qwen Code インサイト',
    'messages across': '件のメッセージ、合計',
    sessions: 'セッション',
    'Your personalized coding journey and patterns':
      'あなた専用のコーディングパターンと軌跡',

    Messages: 'メッセージ',
    Lines: '行',
    Files: 'ファイル',
    Days: '日',
    'Msgs/Day': 'メッセージ/日',

    'At a Glance': '概要',
    "What's working": 'うまくいっていること',
    "What's hindering you": '妨げになっていること',
    'Quick wins to try': '試すべきクイックウィン',
    'Ambitious workflows': '野心的なワークフロー',
    'Impressive Things You Did →': '印象的な成果 →',
    'Where Things Go Wrong →': '問題が発生する場所 →',
    'Features to Try →': '試すべき機能 →',
    'On the Horizon →': '今後の展望 →',

    'What You Work On': 'あなたの取り組み内容',
    'How You Use Qwen Code': 'Qwen Code の使い方',
    'Impressive Things': '印象的な成果',
    'Where Things Go Wrong': '問題が発生する場所',
    'Features to Try': '試すべき機能',
    'New Usage Patterns': '新しい使用パターン',
    'On the Horizon': '今後の展望',

    'Existing Qwen Code Features to Try': '試すべき既存の Qwen Code 機能',
    'New Ways to Use Qwen Code': 'Qwen Code の新しい使い方',

    'Active Hours': 'アクティブ時間',
    'Activity Heatmap': 'アクティビティヒートマップ',
    'Showing past year of activity': '過去1年のアクティビティを表示',
    Less: '少ない',
    More: '多い',

    'Export Card': 'カードをエクスポート',
    'Light Theme': 'ライトテーマ',
    'Dark Theme': 'ダークテーマ',

    'Suggested QWEN.md Additions': 'QWEN.md への追加提案',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'これを Qwen Code にコピーして QWEN.md に追加するだけです。',
    'Copied All!': 'すべてコピーしました！',
    'Copy All Checked': 'チェックした項目をすべてコピー',

    'Key pattern:': 'キーパターン：',
    'Getting started:': 'はじめに：',
    'Paste into Qwen Code:': 'Qwen Code に貼り付け：',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'これを Qwen Code にコピーするだけで設定されます。',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'これを Qwen Code にコピーするだけで手順を案内してくれます。',
    "What Helped Most (Qwen's Capabilities)": '最も役立ったこと（Qwen の機能）',
    Outcomes: '成果',
    'Primary Friction Types': '主な摩擦タイプ',
    'Inferred Satisfaction (model-estimated)': '推定満足度（モデル推定）',
    'What You Wanted': 'あなたが望んだこと',
    'Top Tools Used': 'よく使ったツール',
    Morning: '朝',
    Afternoon: '午後',
    Evening: '夕方',
    Night: '夜',
  },

  // Portuguese
  pt: {
    'Qwen Code Insights': 'Insights do Qwen Code',
    'messages across': 'mensagens em',
    sessions: 'sessões',
    'Your personalized coding journey and patterns':
      'Sua jornada e padrões de codificação personalizados',

    Messages: 'Mensagens',
    Lines: 'Linhas',
    Files: 'Arquivos',
    Days: 'Dias',
    'Msgs/Day': 'Msgs/Dia',

    'At a Glance': 'Resumo',
    "What's working": 'O que está funcionando',
    "What's hindering you": 'O que está atrapalhando',
    'Quick wins to try': 'Vitórias rápidas para tentar',
    'Ambitious workflows': 'Fluxos de trabalho ambiciosos',
    'Impressive Things You Did →': 'Coisas impressionantes →',
    'Where Things Go Wrong →': 'Onde as coisas dão errado →',
    'Features to Try →': 'Recursos para tentar →',
    'On the Horizon →': 'No horizonte →',

    'What You Work On': 'No que você trabalha',
    'How You Use Qwen Code': 'Como você usa o Qwen Code',
    'Impressive Things': 'Coisas impressionantes',
    'Where Things Go Wrong': 'Onde as coisas dão errado',
    'Features to Try': 'Recursos para tentar',
    'New Usage Patterns': 'Novos padrões de uso',
    'On the Horizon': 'No horizonte',

    'Existing Qwen Code Features to Try':
      'Recursos existentes do Qwen Code para tentar',
    'New Ways to Use Qwen Code': 'Novas formas de usar o Qwen Code',

    'Active Hours': 'Horários ativos',
    'Activity Heatmap': 'Mapa de calor de atividade',
    'Showing past year of activity': 'Mostrando o último ano de atividade',
    Less: 'Menos',
    More: 'Mais',

    'Export Card': 'Exportar cartão',
    'Light Theme': 'Tema claro',
    'Dark Theme': 'Tema escuro',

    'Suggested QWEN.md Additions': 'Sugestões de adições ao QWEN.md',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Basta copiar isso para o Qwen Code para adicionar ao seu QWEN.md.',
    'Copied All!': 'Tudo copiado!',
    'Copy All Checked': 'Copiar todos os marcados',

    'Key pattern:': 'Padrão principal:',
    'Getting started:': 'Começando:',
    'Paste into Qwen Code:': 'Colar no Qwen Code:',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'Basta copiar isso para o Qwen Code e ele configurará para você.',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'Basta copiar isso para o Qwen Code e ele guiará você.',
    "What Helped Most (Qwen's Capabilities)":
      'O que mais ajudou (recursos do Qwen)',
    Outcomes: 'Resultados',
    'Primary Friction Types': 'Tipos primários de atrito',
    'Inferred Satisfaction (model-estimated)':
      'Satisfação inferida (estimativa do modelo)',
    'What You Wanted': 'O que você queria',
    'Top Tools Used': 'Ferramentas mais usadas',
    Morning: 'Manhã',
    Afternoon: 'Tarde',
    Evening: 'Noite',
    Night: 'Madrugada',
  },
};

// Map language codes/names to translation keys
function normalizeLocale(locale: string): string {
  const lowered = locale.toLowerCase();
  // Handle locale variants
  if (lowered.startsWith('zh')) return 'zh';
  if (lowered.startsWith('ru')) return 'ru';
  if (lowered.startsWith('de')) return 'de';
  if (lowered.startsWith('ja')) return 'ja';
  if (lowered.startsWith('pt')) return 'pt';
  // Handle full names
  const nameMap: Record<string, string> = {
    chinese: 'zh',
    russian: 'ru',
    german: 'de',
    japanese: 'ja',
    portuguese: 'pt',
    english: 'en',
  };
  return nameMap[lowered] || 'en';
}

let currentLocale = 'en';

/**
 * Set the locale for translations.
 * @param locale - Language code or name (e.g., 'zh', 'Chinese', 'zh-CN')
 */
export function setLocale(locale: string): void {
  currentLocale = normalizeLocale(locale);
}

/**
 * Get the current locale.
 */
export function getLocale(): string {
  return currentLocale;
}

/**
 * Translate a string key. Falls back to the key itself if not found.
 * @param key - The translation key
 * @param locale - Optional override locale
 */
export function t(key: string, locale?: string): string {
  const loc = locale ? normalizeLocale(locale) : currentLocale;
  const dict = translations[loc] || translations['en'];
  return dict[key] ?? key;
}
