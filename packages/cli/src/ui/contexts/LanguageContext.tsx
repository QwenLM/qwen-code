/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { SUPPORTED_LANGUAGES, getLanguageByCode, getCurrentLanguage, setGlobalLanguageUpdateCallback, type LanguageConfig } from '../commands/langCommand.js';

interface LanguageContextType {
  currentLanguage: LanguageConfig;
  setLanguage: (languageCode: string) => boolean;
  supportedLanguages: LanguageConfig[];
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

interface LanguageProviderProps {
  children: ReactNode;
  settings: LoadedSettings;
}

// 简单的翻译字典
const translations: Record<string, Record<string, string>> = {
  en: {
    'help.title': 'Help',
    'help.basics': 'Basics:',
    'help.commands': 'Commands:',
    'help.addContext': 'Add context',
    'help.shellMode': 'Shell mode',
    'footer.help': 'Press ? for help',
    'footer.quit': 'Ctrl+C to quit',
    'auth.required': 'Authentication required',
    'theme.changed': 'Theme changed',
    'loading': 'Loading...',
  },
  zh: {
    'help.title': '帮助',
    'help.basics': '基础:',
    'help.commands': '命令:',
    'help.addContext': '添加上下文',
    'help.shellMode': 'Shell 模式',
    'footer.help': '按 ? 获取帮助',
    'footer.quit': 'Ctrl+C 退出',
    'auth.required': '需要身份验证',
    'theme.changed': '主题已更改',
    'loading': '加载中...',
  },
  'zh-CN': {
    'help.title': '帮助',
    'help.basics': '基础:',
    'help.commands': '命令:',
    'help.addContext': '添加上下文',
    'help.shellMode': 'Shell 模式',
    'footer.help': '按 ? 获取帮助',
    'footer.quit': 'Ctrl+C 退出',
    'auth.required': '需要身份验证',
    'theme.changed': '主题已更改',
    'loading': '加载中...',
  },
  'zh-TW': {
    'help.title': '說明',
    'help.basics': '基礎:',
    'help.commands': '命令:',
    'help.addContext': '添加上下文',
    'help.shellMode': 'Shell 模式',
    'footer.help': '按 ? 獲取說明',
    'footer.quit': 'Ctrl+C 退出',
    'auth.required': '需要身份驗證',
    'theme.changed': '主題已更改',
    'loading': '載入中...',
  },
  ja: {
    'help.title': 'ヘルプ',
    'help.basics': '基本:',
    'help.commands': 'コマンド:',
    'help.addContext': 'コンテキストを追加',
    'help.shellMode': 'シェルモード',
    'footer.help': '? でヘルプ',
    'footer.quit': 'Ctrl+C で終了',
    'auth.required': '認証が必要',
    'theme.changed': 'テーマが変更されました',
    'loading': '読み込み中...',
  },
  ko: {
    'help.title': '도움말',
    'help.basics': '기본:',
    'help.commands': '명령어:',
    'help.addContext': '컨텍스트 추가',
    'help.shellMode': '셸 모드',
    'footer.help': '? 를 눌러서 도움말',
    'footer.quit': 'Ctrl+C 로 종료',
    'auth.required': '인증이 필요합니다',
    'theme.changed': '테마가 변경되었습니다',
    'loading': '로딩 중...',
  },
  es: {
    'help.title': 'Ayuda',
    'help.basics': 'Básicos:',
    'help.commands': 'Comandos:',
    'help.addContext': 'Agregar contexto',
    'help.shellMode': 'Modo shell',
    'footer.help': 'Presiona ? para ayuda',
    'footer.quit': 'Ctrl+C para salir',
    'auth.required': 'Autenticación requerida',
    'theme.changed': 'Tema cambiado',
    'loading': 'Cargando...',
  },
  fr: {
    'help.title': 'Aide',
    'help.basics': 'Bases:',
    'help.commands': 'Commandes:',
    'help.addContext': 'Ajouter contexte',
    'help.shellMode': 'Mode shell',
    'footer.help': 'Appuyez sur ? pour l\'aide',
    'footer.quit': 'Ctrl+C pour quitter',
    'auth.required': 'Authentification requise',
    'theme.changed': 'Thème changé',
    'loading': 'Chargement...',
  },
  de: {
    'help.title': 'Hilfe',
    'help.basics': 'Grundlagen:',
    'help.commands': 'Befehle:',
    'help.addContext': 'Kontext hinzufügen',
    'help.shellMode': 'Shell-Modus',
    'footer.help': 'Drücken Sie ? für Hilfe',
    'footer.quit': 'Ctrl+C zum Beenden',
    'auth.required': 'Authentifizierung erforderlich',
    'theme.changed': 'Theme geändert',
    'loading': 'Lädt...',
  },
  ru: {
    'help.title': 'Справка',
    'help.basics': 'Основы:',
    'help.commands': 'Команды:',
    'help.addContext': 'Добавить контекст',
    'help.shellMode': 'Режим оболочки',
    'footer.help': 'Нажмите ? для справки',
    'footer.quit': 'Ctrl+C для выхода',
    'auth.required': 'Требуется аутентификация',
    'theme.changed': 'Тема изменена',
    'loading': 'Загрузка...',
  },
};

export const LanguageProvider: React.FC<LanguageProviderProps> = ({ children, settings }) => {
  const [currentLanguage, setCurrentLanguage] = useState<LanguageConfig>(() => 
    getCurrentLanguage(settings)
  );

  // 监听设置变化
  useEffect(() => {
    const newLanguage = getCurrentLanguage(settings);
    if (newLanguage.code !== currentLanguage.code) {
      setCurrentLanguage(newLanguage);
    }
  }, [settings.merged.language, currentLanguage.code]);

  // 注册全局语言更新回调
  useEffect(() => {
    setGlobalLanguageUpdateCallback((languageCode: string) => {
      const newLang = getLanguageByCode(languageCode);
      if (!newLang) {
        return false;
      }

      try {
        // 保存到设置
        settings.setValue(SettingScope.User, 'language', newLang.code);
        // 立即更新当前语言状态
        setCurrentLanguage(newLang);
        return true;
      } catch (error) {
        console.error('Failed to save language setting:', error);
        return false;
      }
    });

    // 清理函数
    return () => {
      setGlobalLanguageUpdateCallback(null);
    };
  }, [settings]);

  const setLanguage = (languageCode: string): boolean => {
    const newLang = getLanguageByCode(languageCode);
    if (!newLang) {
      return false;
    }

    try {
      // 保存到设置
      settings.setValue(SettingScope.User, 'language', newLang.code);
      // 立即更新当前语言状态
      setCurrentLanguage(newLang);
      return true;
    } catch (error) {
      console.error('Failed to save language setting:', error);
      return false;
    }
  };

  const t = (key: string): string => {
    const langCode = currentLanguage.code;
    const langTranslations = translations[langCode] || translations['en'];
    return langTranslations[key] || key;
  };

  const value: LanguageContextType = {
    currentLanguage,
    setLanguage,
    supportedLanguages: SUPPORTED_LANGUAGES,
    t,
  };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}; 