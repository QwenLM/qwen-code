/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { useI18n, type WebShellLanguage } from '../i18n';

type Message = string | ((vars?: Record<string, string | number>) => string);

// 搜索文案只随交互组件加载，避免进入只读 HTML 导出的共享翻译包。
const EN_MESSAGES: Record<string, Message> = {
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
};

const messages: Record<WebShellLanguage, Record<string, Message>> = {
  en: EN_MESSAGES,
  'zh-TW': {
    'chat.searchConversation': '搜尋當前會話',
    'chat.searchConversationPlaceholder': '搜尋訊息和程式碼…',
    'chat.searchConversationHint': '輸入關鍵詞，查詢之前的內容。',
    'chat.searchingConversation': '正在搜尋會話歷史…',
    'chat.searchLoadedOnly':
      '僅可搜尋已載入訊息，更新 Qwen Code 後可搜尋完整歷史。',
    'chat.searchResultPosition': (vars) =>
      `${vars?.['current']} / ${vars?.['total']} 條結果`,
    'chat.searchNoResults': '沒有匹配的訊息。',
    'chat.searchPrevious': '上一個結果',
    'chat.searchNext': '下一個結果',
    'chat.searchResults': '搜尋結果',
    'chat.searchResultsLimited': (vars) =>
      `僅顯示前 ${vars?.['count']} 條結果，請使用更具體的關鍵詞。`,
    'chat.searchFailed': '未能搜尋全部歷史，結果可能不完整。',
    'chat.searchLocateFailed': '無法定位此結果，請重新搜尋以重新整理結果。',
    'chat.searchUser': '你',
    'chat.searchAssistant': '助手',
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
  ru: {
    'chat.searchConversation': 'Искать в этом разговоре',
    'chat.searchConversationPlaceholder': 'Искать сообщения и код…',
    'chat.searchConversationHint':
      'Введите ключевое слово, чтобы найти более раннее содержимое.',
    'chat.searchingConversation': 'Поиск по истории разговора…',
    'chat.searchLoadedOnly':
      'Доступны только загруженные сообщения. Обновите Qwen Code, чтобы искать по всей истории.',
    'chat.searchResultPosition': (vars) =>
      `${vars?.['current']} / ${vars?.['total']} результатов`,
    'chat.searchNoResults': 'Нет подходящих сообщений.',
    'chat.searchPrevious': 'Предыдущий результат',
    'chat.searchNext': 'Следующий результат',
    'chat.searchResults': 'Результаты поиска',
    'chat.searchResultsLimited': (vars) =>
      `Показаны первые ${vars?.['count']} результатов. Уточните запрос для более точных совпадений.`,
    'chat.searchFailed':
      'Не удалось выполнить поиск по всей истории. Результаты могут быть неполными.',
    'chat.searchLocateFailed':
      'Этот результат не удалось найти. Повторите поиск, чтобы обновить его.',
    'chat.searchUser': 'Вы',
    'chat.searchAssistant': 'Ассистент',
  },
  ar: {
    'chat.searchConversation': 'البحث في هذه المحادثة',
    'chat.searchConversationPlaceholder': 'ابحث في الرسائل والكود…',
    'chat.searchConversationHint': 'أدخل كلمة مفتاحية للعثور على محتوى سابق.',
    'chat.searchingConversation': 'جارٍ البحث في سجل المحادثة…',
    'chat.searchLoadedOnly':
      'الرسائل المحمّلة فقط متاحة للبحث. حدّث Qwen Code للبحث في السجل الكامل.',
    'chat.searchResultPosition': (vars) =>
      `${vars?.['current']} / ${vars?.['total']} نتائج`,
    'chat.searchNoResults': 'لا توجد رسائل مطابقة.',
    'chat.searchPrevious': 'النتيجة السابقة',
    'chat.searchNext': 'النتيجة التالية',
    'chat.searchResults': 'نتائج البحث',
    'chat.searchResultsLimited': (vars) =>
      `عرض أول ${vars?.['count']} نتيجة. حسّن بحثك لمطابقات أكثر تحديداً.`,
    'chat.searchFailed':
      'تعذر البحث في السجل الكامل. قد تكون النتائج غير مكتملة.',
    'chat.searchLocateFailed':
      'تعذر تحديد موقع هذه النتيجة. أعد البحث لتحديثها.',
    'chat.searchUser': 'أنت',
    'chat.searchAssistant': 'المساعد',
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
