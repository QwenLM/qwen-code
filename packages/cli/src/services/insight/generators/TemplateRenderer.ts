/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import type { InsightData } from '../types/StaticInsightTypes.js';

// Translation strings for insight reports
// These are inlined to avoid import restrictions
const INSIGHT_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    'Qwen Code Insights': 'Qwen Code Insights',
    'Your personalized coding journey and patterns':
      'Your personalized coding journey and patterns',
    'Export Card': 'Export Card',
    'Light Theme': 'Light Theme',
    'Dark Theme': 'Dark Theme',
    Messages: 'Messages',
    Lines: 'Lines',
    Files: 'Files',
    Days: 'Days',
    'Msgs/Day': 'Msgs/Day',
    'At a Glance': 'At a Glance',
    "What's working:": "What's working:",
    "What's hindering you:": "What's hindering you:",
    'Quick wins to try:': 'Quick wins to try:',
    'Ambitious workflows:': 'Ambitious workflows:',
    'Impressive Things You Did →': 'Impressive Things You Did →',
    'Where Things Go Wrong →': 'Where Things Go Wrong →',
    'Features to Try →': 'Features to Try →',
    'On the Horizon →': 'On the Horizon →',
    'What You Work On': 'What You Work On',
    '~{{count}} sessions': '~{{count}} sessions',
    'What You Wanted': 'What You Wanted',
    'Top Tools Used': 'Top Tools Used',
    'How You Use Qwen Code': 'How You Use Qwen Code',
    'Key pattern:': 'Key pattern:',
    'Impressive Things You Did': 'Impressive Things You Did',
    "What Helped Most (Qwen's Capabilities)":
      "What Helped Most (Qwen's Capabilities)",
    Outcomes: 'Outcomes',
    'Where Things Go Wrong': 'Where Things Go Wrong',
    'Primary Friction Types': 'Primary Friction Types',
    'Inferred Satisfaction (model-estimated)':
      'Inferred Satisfaction (model-estimated)',
    'Existing Qwen Code Features to Try': 'Existing Qwen Code Features to Try',
    'Suggested QWEN.md Additions': 'Suggested QWEN.md Additions',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Just copy this into Qwen Code to add it to your QWEN.md.',
    'Copy All Checked ({{count}})': 'Copy All Checked ({{count}})',
    'Copied All!': 'Copied All!',
    "Just copy this into Qwen Code and it'll set it up for you.":
      "Just copy this into Qwen Code and it'll set it up for you.",
    'Why for you:': 'Why for you:',
    'New Ways to Use Qwen Code': 'New Ways to Use Qwen Code',
    "Just copy this into Qwen Code and it'll walk you through it.":
      "Just copy this into Qwen Code and it'll walk you through it.",
    'Paste into Qwen Code:': 'Paste into Qwen Code:',
    'On the Horizon': 'On the Horizon',
    'Getting started:': 'Getting started:',
    'No insight data available': 'No insight data available',
    Unclear: 'Unclear',
  },
  zh: {
    'Qwen Code Insights': 'Qwen Code 洞察报告',
    'Your personalized coding journey and patterns': '您的个性化编程旅程和模式',
    'Export Card': '导出卡片',
    'Light Theme': '浅色主题',
    'Dark Theme': '深色主题',
    Messages: '消息数',
    Lines: '代码行数',
    Files: '文件数',
    Days: '天数',
    'Msgs/Day': '日均消息',
    'At a Glance': '概览',
    "What's working:": '有效做法：',
    "What's hindering you:": '阻碍因素：',
    'Quick wins to try:': '快速尝试：',
    'Ambitious workflows:': '未来工作流：',
    'Impressive Things You Did →': '查看亮点 →',
    'Where Things Go Wrong →': '查看问题 →',
    'Features to Try →': '查看功能 →',
    'On the Horizon →': '查看未来 →',
    'What You Work On': '工作内容',
    '~{{count}} sessions': '约 {{count}} 次会话',
    'What You Wanted': '您的需求',
    'Top Tools Used': '常用工具',
    'How You Use Qwen Code': '使用方式',
    'Key pattern:': '关键模式：',
    'Impressive Things You Did': '亮点工作',
    "What Helped Most (Qwen's Capabilities)": '最有帮助的 Qwen 功能',
    Outcomes: '结果',
    'Where Things Go Wrong': '问题所在',
    'Primary Friction Types': '主要摩擦类型',
    'Inferred Satisfaction (model-estimated)': '满意度推断（模型估算）',
    'Existing Qwen Code Features to Try': '值得尝试的 Qwen Code 功能',
    'Suggested QWEN.md Additions': '建议添加到 QWEN.md',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      '复制以下内容到 Qwen Code 即可添加到 QWEN.md。',
    'Copy All Checked ({{count}})': '复制所有选中项 ({{count}})',
    'Copied All!': '已全部复制！',
    "Just copy this into Qwen Code and it'll set it up for you.":
      '复制以下内容到 Qwen Code，它将为您自动设置。',
    'Why for you:': '为什么适合您：',
    'New Ways to Use Qwen Code': '使用 Qwen Code 的新方式',
    "Just copy this into Qwen Code and it'll walk you through it.":
      '复制以下内容到 Qwen Code，它将引导您完成操作。',
    'Paste into Qwen Code:': '粘贴到 Qwen Code：',
    'On the Horizon': '未来展望',
    'Getting started:': '开始使用：',
    'No insight data available': '暂无洞察数据',
    Unclear: '不明确',
  },
  ja: {
    'Qwen Code Insights': 'Qwen Code インサイト',
    'Your personalized coding journey and patterns':
      'あなた専用のコーディングジャーニーとパターン',
    'Export Card': 'カードをエクスポート',
    'Light Theme': 'ライトテーマ',
    'Dark Theme': 'ダークテーマ',
    Messages: 'メッセージ数',
    Lines: 'コード行数',
    Files: 'ファイル数',
    Days: '日数',
    'Msgs/Day': '1日あたりのメッセージ',
    'At a Glance': '概要',
    "What's working:": '効果的な方法：',
    "What's hindering you:": '妨げとなっている要因：',
    'Quick wins to try:': 'すぐに試せる改善策：',
    'Ambitious workflows:': '将来的なワークフロー：',
    'Impressive Things You Did →': '素晴らしい成果を見る →',
    'Where Things Go Wrong →': '問題点を見る →',
    'Features to Try →': '試す機能を見る →',
    'On the Horizon →': '将来の展望を見る →',
    'What You Work On': '作業内容',
    '~{{count}} sessions': '約 {{count}} セッション',
    'What You Wanted': 'あなたのニーズ',
    'Top Tools Used': 'よく使用するツール',
    'How You Use Qwen Code': '使用方法',
    'Key pattern:': '重要なパターン：',
    'Impressive Things You Did': '素晴らしい成果',
    "What Helped Most (Qwen's Capabilities)": '最も役立った Qwen の機能',
    Outcomes: '結果',
    'Where Things Go Wrong': '問題が発生する箇所',
    'Primary Friction Types': '主な摩擦の種類',
    'Inferred Satisfaction (model-estimated)': '推定満足度（モデル推定）',
    'Existing Qwen Code Features to Try': '試す価値のある Qwen Code 機能',
    'Suggested QWEN.md Additions': 'QWEN.md への追加提案',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'これを Qwen Code にコピーするだけで、QWEN.md に追加されます。',
    'Copy All Checked ({{count}})': '選択した項目をすべてコピー ({{count}})',
    'Copied All!': 'すべてコピーしました！',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'これを Qwen Code にコピーするだけで、自動的に設定されます。',
    'Why for you:': 'なぜあなたに適しているか：',
    'New Ways to Use Qwen Code': 'Qwen Code の新しい使い方',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'これを Qwen Code にコピーするだけで、手順を案内します。',
    'Paste into Qwen Code:': 'Qwen Code に貼り付け：',
    'On the Horizon': '将来の展望',
    'Getting started:': '始め方：',
    'No insight data available': 'インサイトデータがありません',
    Unclear: '不明確',
  },
  de: {
    'Qwen Code Insights': 'Qwen Code Einblicke',
    'Your personalized coding journey and patterns':
      'Ihre personalisierte Coding-Reise und Muster',
    'Export Card': 'Karte exportieren',
    'Light Theme': 'Helles Design',
    'Dark Theme': 'Dunkles Design',
    Messages: 'Nachrichten',
    Lines: 'Codezeilen',
    Files: 'Dateien',
    Days: 'Tage',
    'Msgs/Day': 'Nachr./Tag',
    'At a Glance': 'Auf einen Blick',
    "What's working:": 'Was funktioniert:',
    "What's hindering you:": 'Was Sie behindert:',
    'Quick wins to try:': 'Schnelle Erfolge zum Ausprobieren:',
    'Ambitious workflows:': 'Ehrgeizige Workflows:',
    'Impressive Things You Did →':
      'Beeindruckende Dinge, die Sie getan haben →',
    'Where Things Go Wrong →': 'Wo Probleme auftreten →',
    'Features to Try →': 'Funktionen zum Ausprobieren →',
    'On the Horizon →': 'Am Horizont →',
    'What You Work On': 'Woran Sie arbeiten',
    '~{{count}} sessions': '~{{count}} Sitzungen',
    'What You Wanted': 'Was Sie wollten',
    'Top Tools Used': 'Häufig verwendete Tools',
    'How You Use Qwen Code': 'Wie Sie Qwen Code nutzen',
    'Key pattern:': 'Schlüsselmuster:',
    'Impressive Things You Did': 'Beeindruckende Dinge, die Sie getan haben',
    "What Helped Most (Qwen's Capabilities)":
      'Was am meisten geholfen hat (Qwen-Funktionen)',
    Outcomes: 'Ergebnisse',
    'Where Things Go Wrong': 'Wo Probleme auftreten',
    'Primary Friction Types': 'Hauptreibungstypen',
    'Inferred Satisfaction (model-estimated)':
      'Abgeleitete Zufriedenheit (Modellschätzung)',
    'Existing Qwen Code Features to Try':
      'Vorhandene Qwen Code-Funktionen zum Ausprobieren',
    'Suggested QWEN.md Additions': 'Vorgeschlagene QWEN.md-Ergänzungen',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Kopieren Sie dies einfach in Qwen Code, um es zu Ihrer QWEN.md hinzuzufügen.',
    'Copy All Checked ({{count}})': 'Alle ausgewählten kopieren ({{count}})',
    'Copied All!': 'Alle kopiert!',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'Kopieren Sie dies einfach in Qwen Code und es wird für Sie eingerichtet.',
    'Why for you:': 'Warum für Sie:',
    'New Ways to Use Qwen Code': 'Neue Möglichkeiten, Qwen Code zu nutzen',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'Kopieren Sie dies einfach in Qwen Code und es führt Sie durch den Prozess.',
    'Paste into Qwen Code:': 'In Qwen Code einfügen:',
    'On the Horizon': 'Am Horizont',
    'Getting started:': 'Erste Schritte:',
    'No insight data available': 'Keine Einblicksdaten verfügbar',
    Unclear: 'Unklar',
  },
  pt: {
    'Qwen Code Insights': 'Insights do Qwen Code',
    'Your personalized coding journey and patterns':
      'Sua jornada de codificação personalizada e padrões',
    'Export Card': 'Exportar Cartão',
    'Light Theme': 'Tema Claro',
    'Dark Theme': 'Tema Escuro',
    Messages: 'Mensagens',
    Lines: 'Linhas de código',
    Files: 'Arquivos',
    Days: 'Dias',
    'Msgs/Day': 'Msgs/Dia',
    'At a Glance': 'Visão Geral',
    "What's working:": 'O que está funcionando:',
    "What's hindering you:": 'O que está dificultando:',
    'Quick wins to try:': 'Melhorias rápidas para tentar:',
    'Ambitious workflows:': 'Fluxos de trabalho ambiciosos:',
    'Impressive Things You Did →': 'Coisas Impressionantes que Você Fez →',
    'Where Things Go Wrong →': 'Onde as Coisas Dão Errado →',
    'Features to Try →': 'Recursos para Experimentar →',
    'On the Horizon →': 'No Horizonte →',
    'What You Work On': 'No Que Você Trabalha',
    '~{{count}} sessions': '~{{count}} sessões',
    'What You Wanted': 'O Que Você Queria',
    'Top Tools Used': 'Principais Ferramentas Usadas',
    'How You Use Qwen Code': 'Como Você Usa o Qwen Code',
    'Key pattern:': 'Padrão chave:',
    'Impressive Things You Did': 'Coisas Impressionantes que Você Fez',
    "What Helped Most (Qwen's Capabilities)":
      'O Que Mais Ajudou (Recursos do Qwen)',
    Outcomes: 'Resultados',
    'Where Things Go Wrong': 'Onde as Coisas Dão Errado',
    'Primary Friction Types': 'Principais Tipos de Atrito',
    'Inferred Satisfaction (model-estimated)':
      'Satisfação Inferida (estimada pelo modelo)',
    'Existing Qwen Code Features to Try':
      'Recursos Existentes do Qwen Code para Experimentar',
    'Suggested QWEN.md Additions': 'Adições Sugeridas ao QWEN.md',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Basta copiar isso no Qwen Code para adicionar ao seu QWEN.md.',
    'Copy All Checked ({{count}})': 'Copiar Todos Selecionados ({{count}})',
    'Copied All!': 'Todos Copiados!',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'Basta copiar isso no Qwen Code e ele será configurado para você.',
    'Why for you:': 'Por que para você:',
    'New Ways to Use Qwen Code': 'Novas Maneiras de Usar o Qwen Code',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'Basta copiar isso no Qwen Code e ele o guiará pelo processo.',
    'Paste into Qwen Code:': 'Colar no Qwen Code:',
    'On the Horizon': 'No Horizonte',
    'Getting started:': 'Começando:',
    'No insight data available': 'Nenhum dado de insight disponível',
    Unclear: 'Não claro',
  },
  ru: {
    'Qwen Code Insights': 'Инсайты Qwen Code',
    'Your personalized coding journey and patterns':
      'Ваш персонализированный путь разработки и паттерны',
    'Export Card': 'Экспорт карточки',
    'Light Theme': 'Светлая тема',
    'Dark Theme': 'Темная тема',
    Messages: 'Сообщения',
    Lines: 'Строки кода',
    Files: 'Файлы',
    Days: 'Дни',
    'Msgs/Day': 'Сообщ./день',
    'At a Glance': 'Обзор',
    "What's working:": 'Что работает:',
    "What's hindering you:": 'Что мешает вам:',
    'Quick wins to try:': 'Быстрые улучшения для попробовать:',
    'Ambitious workflows:': 'Амбициозные рабочие процессы:',
    'Impressive Things You Did →': 'Впечатляющие вещи, которые вы сделали →',
    'Where Things Go Wrong →': 'Где возникают проблемы →',
    'Features to Try →': 'Функции для попробовать →',
    'On the Horizon →': 'На горизонте →',
    'What You Work On': 'Над чем вы работаете',
    '~{{count}} sessions': '~{{count}} сессий',
    'What You Wanted': 'Что вы хотели',
    'Top Tools Used': 'Наиболее используемые инструменты',
    'How You Use Qwen Code': 'Как вы используете Qwen Code',
    'Key pattern:': 'Ключевой паттерн:',
    'Impressive Things You Did': 'Впечатляющие вещи, которые вы сделали',
    "What Helped Most (Qwen's Capabilities)":
      'Что помогло больше всего (возможности Qwen)',
    Outcomes: 'Результаты',
    'Where Things Go Wrong': 'Где возникают проблемы',
    'Primary Friction Types': 'Основные типы трения',
    'Inferred Satisfaction (model-estimated)':
      'Предполагаемая удовлетворенность (оценка модели)',
    'Existing Qwen Code Features to Try':
      'Существующие функции Qwen Code для попробовать',
    'Suggested QWEN.md Additions': 'Предлагаемые дополнения к QWEN.md',
    'Just copy this into Qwen Code to add it to your QWEN.md.':
      'Просто скопируйте это в Qwen Code, чтобы добавить в ваш QWEN.md.',
    'Copy All Checked ({{count}})': 'Копировать все отмеченные ({{count}})',
    'Copied All!': 'Все скопировано!',
    "Just copy this into Qwen Code and it'll set it up for you.":
      'Просто скопируйте это в Qwen Code, и он настроит все для вас.',
    'Why for you:': 'Почему для вас:',
    'New Ways to Use Qwen Code': 'Новые способы использования Qwen Code',
    "Just copy this into Qwen Code and it'll walk you through it.":
      'Просто скопируйте это в Qwen Code, и он проведет вас через процесс.',
    'Paste into Qwen Code:': 'Вставить в Qwen Code:',
    'On the Horizon': 'На горизонте',
    'Getting started:': 'Начало работы:',
    'No insight data available': 'Нет доступных данных инсайтов',
    Unclear: 'Неясно',
  },
};

export class TemplateRenderer {
  private language: string;
  private translations: Record<string, string>;

  constructor(language: string = 'en') {
    this.language = language;
    this.translations =
      INSIGHT_TRANSLATIONS[language] || INSIGHT_TRANSLATIONS['en'];
  }

  // Get translation for a key
  private t(key: string): string {
    return this.translations[key] || key;
  }

  // Render the complete HTML file
  async renderInsightHTML(insights: InsightData): Promise<string> {
    // Build translations object for frontend (only include insight-related keys)
    const insightKeys = [
      'Qwen Code Insights',
      'Your personalized coding journey and patterns',
      'Export Card',
      'Light Theme',
      'Dark Theme',
      'Messages',
      'Lines',
      'Files',
      'Days',
      'Msgs/Day',
      'At a Glance',
      "What's working:",
      "What's hindering you:",
      'Quick wins to try:',
      'Ambitious workflows:',
      'Impressive Things You Did →',
      'Where Things Go Wrong →',
      'Features to Try →',
      'On the Horizon →',
      'What You Work On',
      '~{{count}} sessions',
      'What You Wanted',
      'Top Tools Used',
      'How You Use Qwen Code',
      'Key pattern:',
      'Impressive Things You Did',
      "What Helped Most (Qwen's Capabilities)",
      'Outcomes',
      'Where Things Go Wrong',
      'Primary Friction Types',
      'Inferred Satisfaction (model-estimated)',
      'Existing Qwen Code Features to Try',
      'Suggested QWEN.md Additions',
      'Just copy this into Qwen Code to add it to your QWEN.md.',
      'Copy All Checked ({{count}})',
      'Copied All!',
      "Just copy this into Qwen Code and it'll set it up for you.",
      'Why for you:',
      'New Ways to Use Qwen Code',
      "Just copy this into Qwen Code and it'll walk you through it.",
      'Paste into Qwen Code:',
      'On the Horizon',
      'Getting started:',
      'No insight data available',
      'Unclear',
    ];

    const frontendTranslations: Record<string, string> = {};
    for (const key of insightKeys) {
      frontendTranslations[key] = this.t(key);
    }

    const html = `<!doctype html>
<html lang="${this.language}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${this.t('Qwen Code Insights')}</title>
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
      window.INSIGHT_TRANSLATIONS = ${JSON.stringify(frontendTranslations)};
      window.INSIGHT_LANGUAGE = '${this.language}';
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
