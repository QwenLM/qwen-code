/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { INSIGHT_JS, INSIGHT_CSS } from '@qwen-code/web-templates';
import type { InsightData } from '../types/StaticInsightTypes.js';
import type { SupportedLanguage } from '../../../i18n/languages.js';

// Built-in translations for insight report static text
const INSIGHT_TRANSLATIONS: Record<
  SupportedLanguage,
  Record<string, string>
> = {
  en: {
    'Qwen Code Insights': 'Qwen Code Insights',
    'Your personalized coding journey and patterns':
      'Your personalized coding journey and patterns',
    'messages across': 'messages across',
    sessions: 'sessions',
    'Export Card': 'Export Card',
    'Light Theme': 'Light Theme',
    'Dark Theme': 'Dark Theme',
    'No insight data available': 'No insight data available',
    'At a Glance': 'At a Glance',
    'Table of Contents': 'Table of Contents',
    'Project Areas': 'Project Areas',
    'Interaction Style': 'Interaction Style',
    'Impressive Workflows': 'Impressive Workflows',
    'Friction Points': 'Friction Points',
    Improvements: 'Improvements',
    'Future Opportunities': 'Future Opportunities',
    'Memorable Moment': 'Memorable Moment',
  },
  zh: {
    'Qwen Code Insights': 'Qwen Code 洞察',
    'Your personalized coding journey and patterns': '您的个性化编程之旅和模式',
    'messages across': '条消息，共',
    sessions: '次会话',
    'Export Card': '导出卡片',
    'Light Theme': '浅色主题',
    'Dark Theme': '深色主题',
    'No insight data available': '无可用洞察数据',
    'At a Glance': '一览',
    'Table of Contents': '目录',
    'Project Areas': '项目领域',
    'Interaction Style': '交互风格',
    'Impressive Workflows': '令人印象深刻的流程',
    'Friction Points': '摩擦点',
    Improvements: '改进建议',
    'Future Opportunities': '未来机会',
    'Memorable Moment': '难忘时刻',
  },
  ja: {
    'Qwen Code Insights': 'Qwen Code インサイト',
    'Your personalized coding journey and patterns':
      'あなたのパーソナライズされたコーディングの旅とパターン',
    'messages across': '件のメッセージ、合計',
    sessions: '回のセッション',
    'Export Card': 'カードをエクスポート',
    'Light Theme': 'ライトテーマ',
    'Dark Theme': 'ダークテーマ',
    'No insight data available': 'インサイトデータがありません',
    'At a Glance': '一目でわかる',
    'Table of Contents': '目次',
    'Project Areas': 'プロジェクトエリア',
    'Interaction Style': 'インタラクションスタイル',
    'Impressive Workflows': '印象的なワークフロー',
    'Friction Points': 'フラストレーションポイント',
    Improvements: '改善提案',
    'Future Opportunities': '将来の機会',
    'Memorable Moment': '思い出に残る瞬間',
  },
  pt: {
    'Qwen Code Insights': 'Qwen Code Insights',
    'Your personalized coding journey and patterns':
      'Sua jornada e padrões de codificação personalizados',
    'messages across': 'mensagens em',
    sessions: 'sessões',
    'Export Card': 'Exportar cartão',
    'Light Theme': 'Tema claro',
    'Dark Theme': 'Tema escuro',
    'No insight data available': 'Nenhum dado de insight disponível',
    'At a Glance': 'De relance',
    'Table of Contents': 'Índice',
    'Project Areas': 'Áreas do Projeto',
    'Interaction Style': 'Estilo de Interação',
    'Impressive Workflows': 'Fluxos de Trabalho Impressionantes',
    'Friction Points': 'Pontos de Fricção',
    Improvements: 'Melhorias',
    'Future Opportunities': 'Oportunidades Futuras',
    'Memorable Moment': 'Momento Memorável',
  },
  ru: {
    'Qwen Code Insights': 'Инсайты Qwen Code',
    'Your personalized coding journey and patterns':
      'Ваше персонализированное путешествие по кодированию и шаблоны',
    'messages across': 'сообщений в',
    sessions: 'сессиях',
    'Export Card': 'Экспортировать карточку',
    'Light Theme': 'Светлая тема',
    'Dark Theme': 'Тёмная тема',
    'No insight data available': 'Нет доступных инсайтов',
    'At a Glance': 'Вкратце',
    'Table of Contents': 'Содержание',
    'Project Areas': 'Области проекта',
    'Interaction Style': 'Стиль взаимодействия',
    'Impressive Workflows': 'Впечатляющие рабочие процессы',
    'Friction Points': 'Точки трения',
    Improvements: 'Улучшения',
    'Future Opportunities': 'Будущие возможности',
    'Memorable Moment': 'Запоминающийся момент',
  },
  de: {
    'Qwen Code Insights': 'Qwen Code Einblicke',
    'Your personalized coding journey and patterns':
      'Ihre personalisierte Coding-Reise und Muster',
    'messages across': 'Nachrichten in',
    sessions: 'Sitzungen',
    'Export Card': 'Karte exportieren',
    'Light Theme': 'Helles Design',
    'Dark Theme': 'Dunkles Design',
    'No insight data available': 'Keine Einblicke verfügbar',
    'At a Glance': 'Auf einen Blick',
    'Table of Contents': 'Inhaltsverzeichnis',
    'Project Areas': 'Projektbereiche',
    'Interaction Style': 'Interaktionsstil',
    'Impressive Workflows': 'Beeindruckende Arbeitsabläufe',
    'Friction Points': 'Reibungspunkte',
    Improvements: 'Verbesserungen',
    'Future Opportunities': 'Zukünftige Möglichkeiten',
    'Memorable Moment': 'Unvergesslicher Moment',
  },
};

export class TemplateRenderer {
  // Render the complete HTML file with localization support
  async renderInsightHTML(
    insights: InsightData,
    language: SupportedLanguage = 'en',
  ): Promise<string> {
    const translations =
      INSIGHT_TRANSLATIONS[language as keyof typeof INSIGHT_TRANSLATIONS] ||
      INSIGHT_TRANSLATIONS['en'];
    const htmlLang = language === 'zh' ? 'zh-CN' : language;

    const html = `<!doctype html>
<html lang="${htmlLang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${translations['Qwen Code Insights']}</title>
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
      window.INSIGHT_LANGUAGE = '${language}';
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
