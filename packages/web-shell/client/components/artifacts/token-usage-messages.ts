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
  'tokenUsage.successRate': 'Success rate',
  'tokenUsage.successRateHint':
    'API calls that returned without an error. Each retry counts as a call.',
  'tokenUsage.successDetail': (v) =>
    String(v?.failed ?? '0') === '0'
      ? `All ${v?.requests ?? 0} requests succeeded`
      : `${v?.failed} of ${v?.requests ?? 0} requests failed`,
  'tokenUsage.firstTokenDetail': (v) => `First token avg ${v?.duration ?? ''}`,
  'tokenUsage.modelSharesLabel': 'Token share by model',
  'tokenUsage.trendTitle': 'Speed over time',
  'tokenUsage.trendSeconds': 'seconds',
  'tokenUsage.trendFailed': 'Failed',
  'tokenUsage.trendNote':
    'Each dot is one request; the line is the median of five neighbors. × marks a failed request.',
  'tokenUsage.trendSummary': (v) =>
    `${v?.metric ?? ''} per request over time. Median: ${v?.models ?? ''}`,
  'tokenUsage.trendFailure': (v) => `Failed · ${v?.kind ?? ''}`,
  'tokenUsage.trendSpeed': (v) =>
    `${v?.rate ?? ''} tok/s · first token ${v?.ttft ?? ''}`,
  'tokenUsage.trendTtftOnly': (v) => `First token ${v?.ttft ?? ''}`,
  'tokenUsage.trendOutput': (v) =>
    `${v?.count ?? 0} output tokens in ${v?.duration ?? ''}`,
  'tokenUsage.speedSpread': (v) =>
    `p50 ${v?.p50 ?? ''} · p10–p90 ${v?.p10 ?? ''}–${v?.p90 ?? ''} tok/s`,
  'tokenUsage.failuresByKind': (v) => `Failed: ${v?.kinds ?? ''}`,
  'tokenUsage.unavailable': 'Token usage is unavailable for this session.',
  'tokenUsage.bar.turns': (v) =>
    `${v?.count ?? 0} ${Number(v?.count) === 1 ? 'turn' : 'turns'}`,
  'tokenUsage.bar.tokens': (v) => `${v?.count ?? 0} tok`,
  'tokenUsage.bar.cacheHit': (v) => `${v?.percent ?? 0}% cache hit`,
  'tokenUsage.bar.detailTokens': (v) =>
    `Total ${v?.total ?? 0} · Input ${v?.input ?? 0} · Cache ${v?.cached ?? 0} · Output ${v?.output ?? 0}`,
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
  'tokenUsage.successRate': '成功率',
  'tokenUsage.successRateHint': '未报错的 API 调用占比，每次重试单独计数。',
  'tokenUsage.successDetail': (v) =>
    String(v?.failed ?? '0') === '0'
      ? `${v?.requests ?? 0} 次请求全部成功`
      : `${v?.requests ?? 0} 次请求中 ${v?.failed} 次失败`,
  'tokenUsage.firstTokenDetail': (v) => `首 token 平均 ${v?.duration ?? ''}`,
  'tokenUsage.modelSharesLabel': '各模型 Token 占比',
  'tokenUsage.trendTitle': '速度趋势',
  'tokenUsage.trendSeconds': '秒',
  'tokenUsage.trendFailed': '失败',
  'tokenUsage.trendNote':
    '每个点是一次请求，线是相邻 5 次的中位数。× 表示失败的请求。',
  'tokenUsage.trendSummary': (v) =>
    `每次请求的${v?.metric ?? ''}随时间变化。中位数：${v?.models ?? ''}`,
  'tokenUsage.trendFailure': (v) => `失败 · ${v?.kind ?? ''}`,
  'tokenUsage.trendSpeed': (v) =>
    `${v?.rate ?? ''} tok/s · 首 token ${v?.ttft ?? ''}`,
  'tokenUsage.trendTtftOnly': (v) => `首 token ${v?.ttft ?? ''}`,
  'tokenUsage.trendOutput': (v) =>
    `输出 ${v?.count ?? 0} token，耗时 ${v?.duration ?? ''}`,
  'tokenUsage.speedSpread': (v) =>
    `p50 ${v?.p50 ?? ''} · p10–p90 ${v?.p10 ?? ''}–${v?.p90 ?? ''} tok/s`,
  'tokenUsage.failuresByKind': (v) => `失败：${v?.kinds ?? ''}`,
  'tokenUsage.unavailable': '当前会话无法读取 Token 消耗。',
  'tokenUsage.bar.turns': (v) => `${v?.count ?? 0} 轮`,
  'tokenUsage.bar.tokens': (v) => `${v?.count ?? 0} tok`,
  'tokenUsage.bar.cacheHit': (v) => `缓存命中 ${v?.percent ?? 0}%`,
  'tokenUsage.bar.detailTokens': (v) =>
    `总计 ${v?.total ?? 0} · 输入 ${v?.input ?? 0} · 缓存 ${v?.cached ?? 0} · 输出 ${v?.output ?? 0}`,
};
