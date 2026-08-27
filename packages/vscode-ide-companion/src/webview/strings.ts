/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Copy for the VS Code-native chrome the companion draws around Web Shell —
 * the view header, the conversation history dropdown, onboarding, the account
 * dialog, and the notice bar.
 *
 * Web Shell localizes its own surface from the same `language` signal, so
 * without this the panel renders a Chinese transcript under an English header.
 */

export type ChromeLanguage = 'en' | 'zh-CN';

/** Resolve the webview language the same way Web Shell's `language` prop does. */
export function readLanguage(): ChromeLanguage {
  const language = document.documentElement.lang || navigator.language;
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

const EN = {
  'header.history': 'Past conversations',
  'header.newSession': 'New session',
  'session.new': 'New Session',
  'session.untitled': 'Untitled',
  'session.past': 'Past Conversations',
  'session.searchPlaceholder': 'Search sessions…',
  'session.searchLabel': 'Search conversations',
  'session.listLabel': 'Conversations',
  'session.closeHistory': 'Close conversation history',
  'session.rename': 'Rename',
  'session.renameLabel': 'Rename conversation',
  'session.delete': 'Delete',
  'session.deleteLabel': 'Delete conversation',
  'session.deleteConfirm': 'Delete?',
  'session.deleteConfirmLabel': 'Confirm deleting this conversation',
  'session.empty': 'No sessions available',
  'session.emptyFiltered': 'No matching sessions',
  'session.loading': 'Loading…',
  'session.loadFailed': 'Failed to load sessions.',
  'session.renameFailed': 'Failed to rename session.',
  'session.deleteFailed': 'Failed to delete session.',
  'session.switching': 'Loading conversation…',
  'session.creating': 'Starting new session…',
  'session.createFailed': 'Failed to create a new session.',
  'session.loadError': 'Failed to load the Qwen Code session.',
  'group.today': 'Today',
  'group.yesterday': 'Yesterday',
  'group.thisWeek': 'This Week',
  'group.older': 'Older',
  'time.now': 'now',
  'boot.starting': 'Starting Qwen Code...',
  'boot.failed': 'Qwen Code failed to start.',
  'boot.noFolder': 'Open a folder to use Qwen Code.',
  'onboarding.title': 'Qwen Code',
  'onboarding.subtitle': 'Connect a model provider to start coding with Qwen.',
  'onboarding.cta': 'Get Started',
  'onboarding.connecting': 'Connecting…',
  'onboarding.providers':
    'Supports Coding Plan, ModelStudio API Key, and OpenAI-compatible providers.',
  'auth.signedIn': 'Signed in successfully.',
  'auth.failed': 'Failed to connect to Qwen Code.',
  'account.title': 'Account Information',
  'account.authType': 'Auth Method',
  'account.envKey': 'API Key Env',
  'account.baseUrl': 'Base URL',
  'account.model': 'Current Model',
  'account.unknown': 'Unknown',
  'account.error': 'Error',
  'composer.addContext': 'Add context',
  'composer.placeholder': 'Ask Qwen Code or @ a file',
  'composer.editing': 'Editing message',
  'composer.cancelEditing': 'Cancel editing',
  'composer.editUnavailable':
    'The message cannot be edited before the session is ready.',
  'composer.editExpired': 'The original message can no longer be edited.',
  'context.included': 'Included',
  'context.excluded': 'Excluded',
  'context.include': 'Include active file context',
  'context.exclude': 'Exclude active file context',
  'insight.progressDetail': 'Processing your chat history…',
  'insight.ready': 'Insight report generated:',
  'notice.open': 'Open',
  'notice.dismiss': 'Dismiss',
  'cmd.model.label': 'Switch model...',
  'cmd.model.description': 'Switch the active model',
  'cmd.auth.description': 'Configure Coding Plan or API Key',
  'cmd.account.label': 'Account',
  'cmd.account.description': 'Show current account and authentication info',
  'cmd.export.description': 'Export the current conversation',
  'cmd.section.model': 'Model',
  'cmd.section.account': 'Account',
  'cmd.section.session': 'Session',
  'common.close': 'Close',
} as const;

export type ChromeStringKey = keyof typeof EN;

const ZH: Record<ChromeStringKey, string> = {
  'header.history': '历史会话',
  'header.newSession': '新建会话',
  'session.new': '新会话',
  'session.untitled': '未命名',
  'session.past': '历史会话',
  'session.searchPlaceholder': '搜索会话…',
  'session.searchLabel': '搜索会话',
  'session.listLabel': '会话列表',
  'session.closeHistory': '关闭历史会话',
  'session.rename': '重命名',
  'session.renameLabel': '重命名会话',
  'session.delete': '删除',
  'session.deleteLabel': '删除会话',
  'session.deleteConfirm': '确认删除？',
  'session.deleteConfirmLabel': '确认删除该会话',
  'session.empty': '暂无会话',
  'session.emptyFiltered': '没有匹配的会话',
  'session.loading': '加载中…',
  'session.loadFailed': '加载会话列表失败。',
  'session.renameFailed': '重命名会话失败。',
  'session.deleteFailed': '删除会话失败。',
  'session.switching': '正在加载会话…',
  'session.creating': '正在创建新会话…',
  'session.createFailed': '创建新会话失败。',
  'session.loadError': '加载 Qwen Code 会话失败。',
  'group.today': '今天',
  'group.yesterday': '昨天',
  'group.thisWeek': '本周',
  'group.older': '更早',
  'time.now': '刚刚',
  'boot.starting': '正在启动 Qwen Code…',
  'boot.failed': 'Qwen Code 启动失败。',
  'boot.noFolder': '请先打开一个文件夹以使用 Qwen Code。',
  'onboarding.title': 'Qwen Code',
  'onboarding.subtitle': '连接一个模型服务商，开始使用 Qwen 编码。',
  'onboarding.cta': '开始使用',
  'onboarding.connecting': '连接中…',
  'onboarding.providers':
    '支持 Coding Plan、百炼 API Key 以及兼容 OpenAI 的服务商。',
  'auth.signedIn': '登录成功。',
  'auth.failed': '连接 Qwen Code 失败。',
  'account.title': '账号信息',
  'account.authType': '认证方式',
  'account.envKey': 'API Key 环境变量',
  'account.baseUrl': 'Base URL',
  'account.model': '当前模型',
  'account.unknown': '未知',
  'account.error': '错误',
  'composer.addContext': '添加上下文',
  'composer.placeholder': '向 Qwen Code 提问，或用 @ 引用文件',
  'composer.editing': '正在编辑消息',
  'composer.cancelEditing': '取消编辑',
  'composer.editUnavailable': '会话尚未就绪，暂时无法编辑该消息。',
  'composer.editExpired': '该消息已无法再编辑。',
  'context.included': '已包含',
  'context.excluded': '已排除',
  'context.include': '包含当前文件上下文',
  'context.exclude': '排除当前文件上下文',
  'insight.progressDetail': '正在分析你的对话历史…',
  'insight.ready': '洞察报告已生成：',
  'notice.open': '打开',
  'notice.dismiss': '关闭',
  'cmd.model.label': '切换模型…',
  'cmd.model.description': '切换当前使用的模型',
  'cmd.auth.description': '配置 Coding Plan 或 API Key',
  'cmd.account.label': '账号',
  'cmd.account.description': '查看当前账号与认证信息',
  'cmd.export.description': '导出当前对话',
  'cmd.section.model': '模型',
  'cmd.section.account': '账号',
  'cmd.section.session': '会话',
  'common.close': '关闭',
};

export type ChromeStrings = (key: ChromeStringKey) => string;

/** Build the lookup for one language. Falls back to English for any gap. */
export function createChromeStrings(language: ChromeLanguage): ChromeStrings {
  const table = language === 'zh-CN' ? ZH : EN;
  return (key) => table[key] || EN[key];
}
