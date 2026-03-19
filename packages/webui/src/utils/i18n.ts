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
    Region: 'Region',
    Back: 'Back',
    Submit: 'Submit',
    'Custom Configuration': 'Custom Configuration',
    'You can configure your API key and models in settings.json':
      'You can configure your API key and models in settings.json',
    'Refer to the documentation for setup instructions.':
      'Refer to the documentation for setup instructions.',
    'Select Authentication Method': 'Select Authentication Method',
    'Login failed. Please try again.': 'Login failed. Please try again.',
    'Welcome to Qwen Code': 'Welcome to Qwen Code',
    'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.':
      'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.',
    'Get Started with Qwen Code': 'Get Started with Qwen Code',
    Cancel: 'Cancel',
    Next: 'Next',
    Previous: 'Previous',
    'Alibaba Cloud (aliyun.com)': 'Alibaba Cloud (aliyun.com)',
    'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
    'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/':
      'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/',
  },
  zh: {
    'Alibaba Cloud Coding Plan': '阿里云百炼 Coding Plan',
    'API Key': 'API 密钥',
    Region: '服务地域',
    Back: '返回',
    Submit: '提交',
    'Custom Configuration': '自定义配置',
    'You can configure your API key and models in settings.json':
      '您可以在 settings.json 中配置 API Key 和模型',
    'Refer to the documentation for setup instructions.':
      '请参考文档了解配置说明。',
    'Select Authentication Method': '选择认证方式',
    'Login failed. Please try again.': '登录失败，请重试。',
    'Welcome to Qwen Code': '欢迎使用 Qwen Code',
    'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.':
      '利用 AI 的力量，以前所未有的速度理解、导航和转换你的代码库。',
    'Get Started with Qwen Code': '开始使用 Qwen Code',
    Cancel: '取消',
    Next: '下一步',
    Previous: '上一步',
    'Alibaba Cloud (aliyun.com)': '阿里云百炼 (aliyun.com)',
    'Alibaba Cloud (alibabacloud.com)': '阿里云国际 (alibabacloud.com)',
    'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/':
      'https://qwenlm.github.io/qwen-code-docs/zh/users/configuration/model-providers/',
  },
  ru: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'API Ключ',
    Region: 'Регион',
    Back: 'Назад',
    Submit: 'Отправить',
    'Custom Configuration': 'Пользовательская конфигурация',
    'You can configure your API key and models in settings.json':
      'Вы можете настроить свой API-ключ и модели в settings.json',
    'Refer to the documentation for setup instructions.':
      'Для получения инструкций по настройке обратитесь к документации.',
    'Select Authentication Method': 'Выберите метод аутентификации',
    'Login failed. Please try again.':
      'Ошибка входа. Пожалуйста, попробуйте еще раз.',
    'Welcome to Qwen Code': 'Добро пожаловать в Qwen Code',
    'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.':
      'Раскройте мощь ИИ, чтобы получать информацию, осуществлять навигацию и преобразовывать вашу кодовую базу быстрее, чем когда-либо.',
    'Get Started with Qwen Code': 'Начать работу с Qwen Code',
    Cancel: 'Отмена',
    Next: 'Далее',
    Previous: 'Назад',
    'Alibaba Cloud (aliyun.com)': 'Alibaba Cloud (aliyun.com)',
    'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
    'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/':
      'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/',
  },
  de: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'API-Schlüssel',
    Region: 'Region',
    Back: 'Zurück',
    Submit: 'Senden',
    'Custom Configuration': 'Benutzerdefinierte Konfiguration',
    'You can configure your API key and models in settings.json':
      'Sie können Ihren API-Schlüssel und Modelle in settings.json konfigurieren',
    'Refer to the documentation for setup instructions.':
      'Beziehen Sie sich für Setup-Anweisungen auf die Dokumentation.',
    'Select Authentication Method': 'Authentifizierungsmethode auswählen',
    'Login failed. Please try again.':
      'Anmeldung fehlgeschlagen. Bitte versuchen Sie es erneut.',
    'Welcome to Qwen Code': 'Willkommen bei Qwen Code',
    'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.':
      'Nutzen Sie die Kraft der KI, um Ihre Codebasis schneller als je zuvor zu verstehen, zu navigieren und zu transformieren.',
    'Get Started with Qwen Code': 'Erste Schritte mit Qwen Code',
    Cancel: 'Abbrechen',
    Next: 'Weiter',
    Previous: 'Zurück',
    'Alibaba Cloud (aliyun.com)': 'Alibaba Cloud (aliyun.com)',
    'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
    'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/':
      'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/',
  },
  ja: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'APIキー',
    Region: 'リージョン',
    Back: '戻る',
    Submit: '送信',
    'Custom Configuration': 'カスタム設定',
    'You can configure your API key and models in settings.json':
      'settings.json で API キーとモデルを設定できます',
    'Refer to the documentation for setup instructions.':
      'セットアップ手順についてはドキュメントを参照してください。',
    'Select Authentication Method': '認証方法を選択',
    'Login failed. Please try again.':
      'ログインに失敗しました。もう一度お試しください。',
    'Welcome to Qwen Code': 'Qwen Code へようこそ',
    'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.':
      'AI の力を解き放ち、これまで以上に高速にコードベースを理解、ナビゲート、変換します。',
    'Get Started with Qwen Code': 'Qwen Code を始める',
    Cancel: 'キャンセル',
    Next: '次へ',
    Previous: '前へ',
    'Alibaba Cloud (aliyun.com)': 'Alibaba Cloud (aliyun.com)',
    'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
    'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/':
      'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/',
  },
  pt: {
    'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
    'API Key': 'Chave de API',
    Region: 'Região',
    Back: 'Voltar',
    Submit: 'Enviar',
    'Custom Configuration': 'Configuração Personalizada',
    'You can configure your API key and models in settings.json':
      'Você pode configurar sua chave de API e modelos em settings.json',
    'Refer to the documentation for setup instructions.':
      'Consulte a documentação para obter instruções de configuração.',
    'Select Authentication Method': 'Selecione o Método de Autenticação',
    'Login failed. Please try again.':
      'Falha no login. Por favor, tente novamente.',
    'Welcome to Qwen Code': 'Bem-vindo ao Qwen Code',
    'Unlock the power of AI to understand, navigate, and transform your codebase faster than ever before.':
      'Desbloqueie o poder da IA ​​para entender, navegar e transformar sua base de código mais rápido do que nunca.',
    'Get Started with Qwen Code': 'Começar com Qwen Code',
    Cancel: 'Cancelar',
    Next: 'Próximo',
    Previous: 'Anterior',
    'Alibaba Cloud (aliyun.com)': 'Alibaba Cloud (aliyun.com)',
    'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
    'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/':
      'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/',
  },
};

/**
 * Get current language from browser navigator or document
 */
export const getCurrentLanguage = (): SupportedLanguage => {
  let lang = 'en';

  // First try to read from HTML lang attribute (injected by VS Code)
  if (typeof document !== 'undefined' && document.documentElement.lang) {
    lang = document.documentElement.lang.toLowerCase();
  } else if (typeof navigator !== 'undefined') {
    // Fallback to browser language
    lang = navigator.language.toLowerCase();
  }

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
