/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SlashCommand, CommandContext, MessageActionReturn } from './types.js';
import { SettingScope } from '../../config/settings.js';

// 支持的语言配置
export interface LanguageConfig {
  code: string;
  name: string;
  nativeName: string;
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
];

export function getLanguageByCode(code: string): LanguageConfig | undefined {
  return SUPPORTED_LANGUAGES.find(lang => lang.code.toLowerCase() === code.toLowerCase());
}

export function getCurrentLanguage(settings: any): LanguageConfig {
  const currentLangCode = settings?.merged?.language || process.env.MINE_AI_LANGUAGE || 'en';
  return getLanguageByCode(currentLangCode) || SUPPORTED_LANGUAGES[0];
}

// 添加一个全局变量来存储语言更新回调
let globalLanguageUpdateCallback: ((languageCode: string) => boolean) | null = null;

export function setGlobalLanguageUpdateCallback(callback: ((languageCode: string) => boolean) | null) {
  globalLanguageUpdateCallback = callback;
}

export const langCommand: SlashCommand = {
  name: 'lang',
  description: 'change interface language / 更改界面语言',
  action: async (context: CommandContext, args: string): Promise<MessageActionReturn | void> => {
    const { services } = context;
    const settings = services.settings;
    
    // 如果没有参数，显示当前语言和可选语言列表
    if (!args.trim()) {
      const currentLang = getCurrentLanguage(settings);
      
      let message = `🌐 **Current Language / 当前语言**: ${currentLang.nativeName} (${currentLang.code})\n\n`;
      message += `**Available Languages / 可选语言:**\n`;
      
      SUPPORTED_LANGUAGES.forEach(lang => {
        const indicator = lang.code === currentLang.code ? '✓ ' : '  ';
        message += `${indicator}\`/lang ${lang.code}\` - ${lang.nativeName} (${lang.name})\n`;
      });
      
      message += `\n**Usage / 使用方法:**\n`;
      message += `\`/lang <code>\` - Set language / 设置语言\n`;
      message += `\`/lang\` - Show this help / 显示帮助\n`;
      message += `\n**Examples / 示例:**\n`;
      message += `\`/lang zh\` - Switch to Chinese / 切换到中文\n`;
      message += `\`/lang en\` - Switch to English / 切换到英文\n`;
      
      return {
        type: 'message',
        messageType: 'info',
        content: message,
      };
    }

    // 设置新语言
    const newLangCode = args.trim().toLowerCase();
    const newLang = getLanguageByCode(newLangCode);
    
    if (!newLang) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ **Language not supported / 不支持的语言**: \`${newLangCode}\`\n\nUse \`/lang\` to see available languages. / 使用 \`/lang\` 查看可用语言。`,
      };
    }

    // 保存语言设置
    try {
      // 首先尝试通过上下文更新语言（如果可用）
      if (globalLanguageUpdateCallback && globalLanguageUpdateCallback(newLang.code)) {
        // 语言上下文更新成功
        const successMessage = newLang.code.startsWith('zh') 
          ? `✅ **语言已更改为**: ${newLang.nativeName} (${newLang.code})\n\n语言设置已立即生效！`
          : `✅ **Language changed to**: ${newLang.nativeName} (${newLang.code})\n\nLanguage setting applied immediately!`;
        
        return {
          type: 'message',
          messageType: 'info',
          content: successMessage,
        };
      } else {
        // 回退到传统方式
        settings.setValue(SettingScope.User, 'language', newLang.code);
        
        // 语言设置已即时生效，无需重启
        const successMessage = newLang.code.startsWith('zh') 
          ? `✅ **语言已更改为**: ${newLang.nativeName} (${newLang.code})\n\n语言设置已立即生效！`
          : `✅ **Language changed to**: ${newLang.nativeName} (${newLang.code})\n\nLanguage setting applied immediately!`;
        
        return {
          type: 'message',
          messageType: 'info',
          content: successMessage,
        };
      }
      
    } catch (error) {
      const errorMessage = `❌ **Failed to save language setting / 保存语言设置失败**: ${error instanceof Error ? error.message : String(error)}`;
      return {
        type: 'message',
        messageType: 'error',
        content: errorMessage,
      };
    }
  },
  
  completion: async (context: CommandContext, partialArg: string) => {
    // 提供语言代码自动补全
    return SUPPORTED_LANGUAGES
      .filter(lang => lang.code.toLowerCase().startsWith(partialArg.toLowerCase()))
      .map(lang => lang.code);
  },
}; 