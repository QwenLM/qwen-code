/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type TokenUsageMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const TOKEN_USAGE_MESSAGES_EN: Record<string, TokenUsageMessage> = {
  'tokenUsage.total': 'Total tokens',
  'tokenUsage.shareTooltip': (v) => `Token share: ${v?.percent ?? '0.0'}%`,
  'tokenUsage.avgLatency': 'Avg latency',
  'tokenUsage.firstToken': 'First token',
  'tokenUsage.generation': 'Generation',
  'tokenUsage.outputSpeed': 'Output speed',
  'tokenUsage.tokensPerSecond': (v) => `${v?.rate ?? ''} tok/s`,
  'tokenUsage.valueWithRate': (v) =>
    `${v?.count ?? 0} (${v?.percent ?? '0.0'}%)`,
  'tokenUsage.cached': 'Cache',
  'tokenUsage.cachedDetail': (v) =>
    `Cache: ${v?.count ?? 0} (${v?.percent ?? '0.0'}%)`,
  'tokenUsage.thoughtsDetail': (v) => `Reasoning: ${v?.count ?? 0}`,
  'tokenUsage.input': 'Input',
  'tokenUsage.inputWithCacheRate': (v) =>
    `${v?.count ?? 0} (cache rate: ${v?.percent ?? '0.0'}%)`,
  'tokenUsage.loadError': 'Failed to load token usage.',
  'tokenUsage.models': 'By model',
  'tokenUsage.noData': 'No API calls in this session yet.',
  'tokenUsage.noTools': 'No tool calls in this session yet.',
  'tokenUsage.open': 'Session token usage',
  'tokenUsage.output': 'Total output',
  'tokenUsage.refresh': 'Refresh',
  'tokenUsage.requests': 'Requests',
  'tokenUsage.retry': 'Retry',
  'tokenUsage.agents': 'By agent',
  'tokenUsage.mainAgent': 'Main Agent',
  'tokenUsage.thoughts': 'Reasoning',
  'tokenUsage.title': 'Token Usage',
  'tokenUsage.toolRow': (v) =>
    `${v?.count ?? 0} calls · ${v?.rate ?? 0}% ok · ${v?.duration ?? ''}`,
  'tokenUsage.tools': 'Tools',
  'tokenUsage.updatedAt': (v) => `Updated ${v?.time ?? ''}`,
  'tokenUsage.unavailable': 'Token usage is unavailable for this session.',
};

export const TOKEN_USAGE_MESSAGES_ZH: Record<string, TokenUsageMessage> = {
  'tokenUsage.total': '总 Token',
  'tokenUsage.shareTooltip': (v) => `Token 占比：${v?.percent ?? '0.0'}%`,
  'tokenUsage.avgLatency': '平均延迟',
  'tokenUsage.firstToken': '首 token',
  'tokenUsage.generation': '生成',
  'tokenUsage.outputSpeed': '输出速度',
  'tokenUsage.tokensPerSecond': (v) => `${v?.rate ?? ''} tok/s`,
  'tokenUsage.valueWithRate': (v) =>
    `${v?.count ?? 0}（${v?.percent ?? '0.0'}%）`,
  'tokenUsage.cached': '缓存',
  'tokenUsage.cachedDetail': (v) =>
    `缓存：${v?.count ?? 0}（${v?.percent ?? '0.0'}%）`,
  'tokenUsage.thoughtsDetail': (v) => `思考：${v?.count ?? 0}`,
  'tokenUsage.input': '输入',
  'tokenUsage.inputWithCacheRate': (v) =>
    `${v?.count ?? 0}（缓存率：${v?.percent ?? '0.0'}%）`,
  'tokenUsage.loadError': 'Token 消耗加载失败。',
  'tokenUsage.models': '按模型',
  'tokenUsage.noData': '本会话还没有 API 调用。',
  'tokenUsage.noTools': '本会话还没有工具调用。',
  'tokenUsage.open': '会话 Token 消耗',
  'tokenUsage.output': '总输出',
  'tokenUsage.refresh': '刷新',
  'tokenUsage.requests': '请求',
  'tokenUsage.retry': '重试',
  'tokenUsage.agents': '按agent',
  'tokenUsage.mainAgent': '主Agent',
  'tokenUsage.thoughts': '思考',
  'tokenUsage.title': 'Token 消耗',
  'tokenUsage.toolRow': (v) =>
    `${v?.count ?? 0} 次 · 成功率 ${v?.rate ?? 0}% · ${v?.duration ?? ''}`,
  'tokenUsage.tools': '工具',
  'tokenUsage.updatedAt': (v) => `更新于 ${v?.time ?? ''}`,
  'tokenUsage.unavailable': '当前会话无法读取 Token 消耗。',
};
