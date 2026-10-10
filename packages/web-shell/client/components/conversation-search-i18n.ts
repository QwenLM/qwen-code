/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { useI18n, type WebShellLanguage } from '../i18n';

type Message = string | ((vars?: Record<string, string | number>) => string);

// 搜索文案只随交互组件加载，避免进入只读 HTML 导出的共享翻译包。
const messages: Record<WebShellLanguage, Record<string, Message>> = {
  en: {
    'chat.searchConversation': 'Search this conversation',
    'chat.searchConversationPlaceholder': 'Search messages and code…',
    'chat.searchConversationHint': 'Enter a keyword to find earlier content.',
    'chat.searchingConversation': 'Searching conversation history…',
    'chat.searchLoadedOnly':
      'Only loaded messages are available. Update Qwen Code to search all history.',
    'chat.searchResultPosition': (vars) =>
      `${vars?.['current']} / ${vars?.['total']} results`,
    'chat.searchNoResults': 'No matching messages.',
    'chat.searchPrevious': 'Previous result',
    'chat.searchNext': 'Next result',
    'chat.searchResults': 'Search results',
    'chat.searchResultsLimited': (vars) =>
      `Showing the first ${vars?.['count']} results. Refine your search for more specific matches.`,
    'chat.searchFailed':
      'Could not search all history. Results may be incomplete.',
    'chat.searchLocateFailed':
      'This result could not be located. Search again to refresh it.',
    'chat.searchUser': 'You',
    'chat.searchAssistant': 'Assistant',
  },
  'zh-CN': {
    'chat.searchConversation': '搜索当前会话',
    'chat.searchConversationPlaceholder': '搜索消息和代码…',
    'chat.searchConversationHint': '输入关键词，查找之前的内容。',
    'chat.searchingConversation': '正在搜索会话历史…',
    'chat.searchLoadedOnly':
      '仅可搜索已加载消息，更新 Qwen Code 后可搜索完整历史。',
    'chat.searchResultPosition': (vars) =>
      `${vars?.['current']} / ${vars?.['total']} 条结果`,
    'chat.searchNoResults': '没有匹配的消息。',
    'chat.searchPrevious': '上一个结果',
    'chat.searchNext': '下一个结果',
    'chat.searchResults': '搜索结果',
    'chat.searchResultsLimited': (vars) =>
      `仅显示前 ${vars?.['count']} 条结果，请使用更具体的关键词。`,
    'chat.searchFailed': '未能搜索全部历史，结果可能不完整。',
    'chat.searchLocateFailed': '无法定位此结果，请重新搜索以刷新结果。',
    'chat.searchUser': '你',
    'chat.searchAssistant': '助手',
  },
};

export function useConversationSearchI18n() {
  const { language, t } = useI18n();
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const message = messages[language]?.[key];
      return message === undefined
        ? t(key, vars)
        : typeof message === 'function'
          ? message(vars)
          : message;
    },
    [language, t],
  );
}
