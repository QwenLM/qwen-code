/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type SupportedLanguage = 'en' | 'zh' | 'ru' | 'de' | 'ja' | 'pt';

const translations: Record<SupportedLanguage, Record<string, string>> = {
  en: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'API Key',
    'Region': 'Region',
    'Back': 'Back',
    'Submit': 'Submit',
    'Custom Configuration': 'Custom Configuration',
    'You can configure your API key and models in settings.json': 'You can configure your API key and models in settings.json',
    'Refer to the documentation for setup instructions.': 'Refer to the documentation for setup instructions.',
    'Select Authentication Method': 'Select Authentication Method',
  },
  zh: {
    'Alibaba Cloud Coding Plan': '阿里云百炼 Coding Plan',
    'API Key': 'API 密钥',
    'Region': '服务地域',
    'Back': '返回',
    'Submit': '提交',
    'Custom Configuration': '自定义配置',
    'You can configure your API key and models in settings.json': '您可以在 settings.json 中配置 API Key 和模型',
    'Refer to the documentation for setup instructions.': '请参考文档了解配置说明。',
    'Select Authentication Method': '选择认证方式',
  },
  ru: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'API Ключ',
    'Region': 'Регион',
    'Back': 'Назад',
    'Submit': 'Отправить',
    'Custom Configuration': 'Пользовательская конфигурация',
    'You can configure your API key and models in settings.json': 'Вы можете настроить свой API-ключ и модели в settings.json',
    'Refer to the documentation for setup instructions.': 'Для получения инструкций по настройке обратитесь к документации.',
    'Select Authentication Method': 'Выберите метод аутентификации',
  },
  de: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'API-Schlüssel',
    'Region': 'Region',
    'Back': 'Zurück',
    'Submit': 'Senden',
    'Custom Configuration': 'Benutzerdefinierte Konfiguration',
    'You can configure your API key and models in settings.json': 'Sie können Ihren API-Schlüssel und Modelle in settings.json konfigurieren',
    'Refer to the documentation for setup instructions.': 'Beziehen Sie sich für Setup-Anweisungen auf die Dokumentation.',
    'Select Authentication Method': 'Authentifizierungsmethode auswählen',
  },
  ja: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'APIキー',
    'Region': 'リージョン',
    'Back': '戻る',
    'Submit': '送信',
    'Custom Configuration': 'カスタム設定',
    'You can configure your API key and models in settings.json': 'settings.json で API キーとモデルを設定できます',
    'Refer to the documentation for setup instructions.': 'セットアップ手順についてはドキュメントを参照してください。',
    'Select Authentication Method': '認証方法を選択',
  },
  pt: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'Chave de API',
    'Region': 'Região',
    'Back': 'Voltar',
    'Submit': 'Enviar',
    'Custom Configuration': 'Configuração Personalizada',
    'You can configure your API key and models in settings.json': 'Você pode configurar sua chave de API e modelos em settings.json',
    'Refer to the documentation for setup instructions.': 'Consulte a documentação para obter instruções de configuração.',
    'Select Authentication Method': 'Selecione o Método de Autenticação',
  },
};

/**
 * Get current language from browser navigator
 */
export const getCurrentLanguage = (): SupportedLanguage => {
  if (typeof navigator === 'undefined') return 'en';
  
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('ru')) return 'ru';
  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('pt')) return 'pt';
  
  return 'en';
};

/**
 * Translate a key based on the current detected language
 */
export const t = (key: keyof typeof translations.en): string => {
  const lang = getCurrentLanguage();
  return translations[lang][key] || translations['en'][key] || key;
};
