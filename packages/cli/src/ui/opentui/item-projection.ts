/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Text projection of the "special" ink command history items (audit 01
 * G-1/2/3/12/14/17): the ink TUI renders them through dedicated components
 * (AboutBox, ToolsList, ModelStatsDisplay, CompressionMessage, …); the
 * OpenTUI transcript speaks plain text, so each item is folded into the same
 * lines those components print, without re-implementing the components.
 *
 * Items whose ink components read runtime state (model/tool/skill stats from
 * `uiTelemetryService`, extensions from `config.getExtensions()`, MCP server
 * status from the core status registry, quit summary from session stats)
 * receive that state through `ItemProjectionContext` — the command host
 * supplies it when projecting.
 */

import {
  findProviderByCredentials,
  getExtensionDisplayName,
  getMCPServerStatus,
  MCPServerStatus,
  resolveMetadataKey,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';
import type { Config, SessionMetrics } from '@qwen-code/qwen-code-core';
import type { HistoryItemWithoutId } from '../types.js';
import { flattenModelsBySource } from '../utils/modelsBySource.js';
import { calculateCost } from '../../utils/costCalculator.js';
import { computeSessionStats } from '../utils/computeStats.js';
import { formatDuration } from '../utils/formatters.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';

/** Runtime state the host supplies for items that read it in ink. */
export interface ItemProjectionContext {
  config?: Config | null;
  stats?: SessionStatsState;
  /** Merged settings (model pricing, …) — ink reads these via useSettings. */
  settings?: LoadedSettings;
  /** Live extension update states (ExtensionsList's context data). */
  extensionsUpdateState?: Map<string, unknown>;
}

function fmtTokensShort(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0.0';
  const p = (part / whole) * 100;
  return p > 100 ? '>100' : p.toFixed(1);
}

/** Parity of AboutBox (systemInfo fields; empty values skipped). */
export function projectAbout(systemInfo: Record<string, unknown>): string {
  const lines: string[] = ['Status'];
  const addField = (label: string, value: string) => {
    if (value) lines.push(`${label}: ${value}`);
  };
  const cliVersion = String(systemInfo['cliVersion'] ?? '');
  const gitCommit = systemInfo['gitCommit'];
  addField(
    'Qwen Code',
    cliVersion + (gitCommit ? ` (${String(gitCommit)})` : ''),
  );
  const nodeVersion = String(systemInfo['nodeVersion'] ?? '');
  const npmVersion = String(systemInfo['npmVersion'] ?? '');
  addField(
    'Runtime',
    [
      nodeVersion ? `Node.js ${nodeVersion}` : '',
      npmVersion ? `npm ${npmVersion}` : '',
    ]
      .filter(Boolean)
      .join(' / '),
  );
  addField('IDE Client', String(systemInfo['ideClient'] ?? ''));
  const lspStatus = systemInfo['lspStatus'];
  if (lspStatus !== undefined) addField('LSP', String(lspStatus));
  addField(
    'OS',
    [
      String(systemInfo['osPlatform'] ?? ''),
      String(systemInfo['osArch'] ?? ''),
      systemInfo['osRelease'] ? `(${String(systemInfo['osRelease'])})` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  const selectedAuthType = String(systemInfo['selectedAuthType'] ?? '');
  const baseUrl = systemInfo['baseUrl'] as string | undefined;
  const apiKeyEnvKey = systemInfo['apiKeyEnvKey'] as string | undefined;
  let authLabel = '';
  if (selectedAuthType) {
    const matched = findProviderByCredentials(baseUrl, apiKeyEnvKey);
    if (matched && resolveMetadataKey(matched) && matched.label) {
      authLabel = matched.label;
    } else if (
      selectedAuthType.startsWith('oauth') ||
      selectedAuthType === 'qwen-oauth'
    ) {
      authLabel = 'Qwen OAuth';
    } else {
      authLabel = `API Key - ${selectedAuthType}`;
    }
  }
  addField('Auth', authLabel);
  const isOAuth =
    authLabel === 'Qwen OAuth' || authLabel.startsWith('Qwen OAuth');
  if (!isOAuth && baseUrl) addField('Base URL', baseUrl);
  const modelVersion = String(systemInfo['modelVersion'] ?? '');
  addField('Model', modelVersion);
  addField('Fast Model', String(systemInfo['fastModel'] ?? '') || modelVersion);
  addField('Session ID', String(systemInfo['sessionId'] ?? ''));
  addField('Sandbox', String(systemInfo['sandboxEnv'] ?? ''));
  const proxy = systemInfo['proxy'] as string | undefined;
  if (proxy) {
    try {
      const url = new URL(proxy);
      if (url.username || url.password) {
        url.username = '***';
        url.password = '***';
        addField('Proxy', url.toString());
      } else {
        addField('Proxy', proxy);
      }
    } catch {
      addField('Proxy', proxy);
    }
  } else {
    addField('Proxy', 'no proxy');
  }
  addField('Memory Usage', String(systemInfo['memoryUsage'] ?? ''));
  return lines.join('\n');
}

/** Parity of views/ToolsList. */
export function projectToolsList(
  tools: ReadonlyArray<{
    name: string;
    displayName?: string;
    description?: string;
  }>,
  showDescriptions: boolean,
): string {
  const lines = ['Available Qwen Code CLI tools:', ''];
  if (tools.length === 0) {
    lines.push(' No tools available');
    return lines.join('\n');
  }
  for (const tool of tools) {
    lines.push(
      ` - ${tool.displayName ?? tool.name}${
        showDescriptions ? ` (${tool.name})` : ''
      }`,
    );
    // ink renders each tool's description under its name when
    // showDescriptions is on (views/ToolsList's MarkdownDisplay row).
    if (showDescriptions && tool.description?.trim()) {
      lines.push(`   ${tool.description.trim()}`);
    }
  }
  return lines.join('\n');
}

/** Parity of views/SkillsList. */
export function projectSkillsList(
  skills: ReadonlyArray<{ name: string; description?: string; level?: string }>,
): string {
  const lines = ['Available skills:', ''];
  if (skills.length === 0) {
    lines.push(' No skills available');
    return lines.join('\n');
  }
  const levelLabel = (level: string): string => {
    switch (level) {
      case 'project':
        return 'Project';
      case 'user':
        return 'User';
      case 'extension':
        return 'Extension';
      case 'bundled':
        return 'Bundled';
      default:
        return level;
    }
  };
  const truncate = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n)}…` : s;
  for (const skill of skills) {
    if (skill.description) {
      const name = truncate(skill.name, 24).padEnd(24);
      lines.push(
        ` - ${name} ${truncate(skill.description, 80)}${
          skill.level ? ` (${levelLabel(skill.level)})` : ''
        }`,
      );
    } else {
      lines.push(` - ${skill.name}`);
    }
  }
  return lines.join('\n');
}

interface FlatModelEntry {
  /** Structured key (raw model name + optional `::source` suffix). */
  key: string;
  label: string;
  metrics: {
    api: { totalRequests: number; totalErrors: number; totalLatencyMs: number };
    tokens: {
      total: number;
      prompt: number;
      cached: number;
      thoughts: number;
      candidates: number;
    };
  };
}

/** Active-model rows; `flattenModelsBySource` already labels + filters. */
function flattenActiveModels(metrics: SessionMetrics): FlatModelEntry[] {
  return flattenModelsBySource(metrics.models).map((entry) => ({
    key: entry.key,
    label: entry.label,
    metrics: entry.metrics as FlatModelEntry['metrics'],
  }));
}

/** Parity of ModelStatsDisplay (reads uiTelemetryService, not the item). */
export function projectModelStats(
  metrics: SessionMetrics,
  modelPricing?: Record<string, unknown>,
): string {
  const entries = flattenActiveModels(metrics);
  if (entries.length === 0) {
    return 'No API calls have been made in this session.';
  }
  const lines = ['Model Stats For Nerds', ''];
  const totals = entries.reduce(
    (acc, entry) => {
      acc.requests += entry.metrics.api.totalRequests;
      acc.errors += entry.metrics.api.totalErrors;
      acc.latency += entry.metrics.api.totalLatencyMs;
      acc.tokens += entry.metrics.tokens.total;
      acc.prompt += entry.metrics.tokens.prompt;
      acc.cached += entry.metrics.tokens.cached;
      acc.thoughts += entry.metrics.tokens.thoughts;
      acc.output += entry.metrics.tokens.candidates;
      return acc;
    },
    {
      requests: 0,
      errors: 0,
      latency: 0,
      tokens: 0,
      prompt: 0,
      cached: 0,
      thoughts: 0,
      output: 0,
    },
  );
  lines.push(`Models: ${entries.map((entry) => entry.label).join(', ')}`);
  lines.push('');
  lines.push('API');
  lines.push(`Requests ${totals.requests.toLocaleString()}`);
  lines.push(
    `Errors ${totals.errors.toLocaleString()} (${totals.requests > 0 ? ((totals.errors / totals.requests) * 100).toFixed(1) : '0.0'}%)`,
  );
  lines.push(
    `Avg Latency ${totals.requests > 0 ? formatDuration(totals.latency / totals.requests) : '0s'}`,
  );
  lines.push('');
  lines.push('Tokens');
  lines.push(`Total ${totals.tokens.toLocaleString()}`);
  lines.push(` ↳ Prompt ${totals.prompt.toLocaleString()}`);
  if (entries.some((entry) => entry.metrics.tokens.cached > 0)) {
    lines.push(
      ` ↳ Cached ${totals.cached.toLocaleString()} (${pct(totals.cached, totals.prompt)}%)`,
    );
  }
  if (entries.some((entry) => entry.metrics.tokens.thoughts > 0)) {
    lines.push(` ↳ Thoughts ${totals.thoughts.toLocaleString()}`);
  }
  lines.push(` ↳ Output ${totals.output.toLocaleString()}`);
  const costs = entries
    .map((entry) =>
      calculateCost({
        inputTokens: entry.metrics.tokens.prompt,
        outputTokens:
          entry.metrics.tokens.candidates + entry.metrics.tokens.thoughts,
        // ink looks pricing up under the RAW model name from the structured
        // key (ModelStatsDisplay getModelName); the display label is
        // normalized and may carry a ` (source)` suffix that never matches.
        pricing: (modelPricing ?? {})[entry.key.split('::')[0]] as Parameters<
          typeof calculateCost
        >[0]['pricing'],
      }),
    )
    .filter((cost): cost is number => cost != null);
  if (costs.length > 0) {
    lines.push('');
    lines.push('Cost');
    lines.push(`Estimated $${costs.reduce((a, b) => a + b, 0).toFixed(4)}`);
  }
  return lines.join('\n');
}

/** Parity of ToolStatsDisplay. */
export function projectToolStats(metrics: SessionMetrics): string {
  const byName = metrics.tools?.byName ?? {};
  const active = Object.entries(byName).filter(
    ([, stats]) => (stats as { count?: number }).count! > 0,
  );
  if (active.length === 0) {
    return 'No tool calls have been made in this session.';
  }
  const lines = [
    'Tool Stats For Nerds',
    '',
    'Tool Name Calls Success Rate Avg Duration',
    '---------------------------------------------------------------',
  ];
  for (const [name, raw] of active) {
    const stats = raw as {
      count: number;
      success: number;
      durationMs: number;
    };
    lines.push(
      `${name} ${stats.count} ${((stats.success / stats.count) * 100).toFixed(1)}% ${formatDuration(stats.durationMs / stats.count)}`,
    );
  }
  let accept = 0;
  let reject = 0;
  let modify = 0;
  for (const raw of Object.values(byName)) {
    const decisions = (raw as { decisions?: Record<string, number> }).decisions;
    accept += decisions?.['accept'] ?? 0;
    reject += decisions?.['reject'] ?? 0;
    modify += decisions?.['modify'] ?? 0;
  }
  const totalReviewed = accept + reject + modify;
  lines.push('');
  lines.push('User Decision Summary');
  lines.push(`Total Reviewed Suggestions: ${totalReviewed}`);
  lines.push(` » Accepted: ${accept}`);
  lines.push(` » Rejected: ${reject}`);
  lines.push(` » Modified: ${modify}`);
  lines.push('');
  lines.push(
    ` Overall Agreement Rate: ${
      totalReviewed > 0
        ? `${((accept / totalReviewed) * 100).toFixed(1)}%`
        : '--'
    }`,
  );
  return lines.join('\n');
}

/** Parity of SkillStatsDisplay. */
export function projectSkillStats(metrics: SessionMetrics): string {
  const skills = metrics.skills ?? { byName: {} };
  const byName = (skills as { byName?: Record<string, unknown> }).byName ?? {};
  const active = Object.entries(byName)
    .filter(([, stats]) => (stats as { count?: number }).count! > 0)
    .sort(
      (a, b) =>
        (b[1] as { count: number }).count - (a[1] as { count: number }).count,
    );
  if (active.length === 0) {
    return 'No skill calls have been made in this session.';
  }
  const lines = [
    'Skill Stats For Nerds',
    '',
    'Skill Name Calls OK Fail Success Rate',
    '-----------------------------------------------------------------------',
  ];
  for (const [name, raw] of active) {
    const stats = raw as { count: number; success: number; fail: number };
    lines.push(
      `${name} ${stats.count} ${stats.success} ${stats.fail} ${((stats.success / stats.count) * 100).toFixed(1)}%`,
    );
  }
  return lines.join('\n');
}

/** Parity of messages/SummaryMessage. */
export function projectSummary(summary: {
  isPending?: boolean;
  stage?: string;
  filePath?: string;
}): string {
  if (summary.isPending) {
    switch (summary.stage) {
      case 'generating':
        return 'Generating project summary...';
      case 'saving':
        return 'Saving project summary...';
      default:
        return 'Processing summary...';
    }
  }
  return `Project summary generated and saved successfully!${
    summary.filePath ? ` Saved to: ${summary.filePath}` : ''
  }`;
}

/** Parity of messages/InsightProgressMessage. */
export function projectInsightProgress(progress: {
  stage: string;
  progress: number;
  detail?: string;
  isComplete?: boolean;
  error?: string;
}): string {
  if (progress.error) {
    return `✕ ${progress.stage}\n${progress.error}`;
  }
  if (progress.isComplete) return `✓ ${progress.stage}`;
  const filled = Math.round((progress.progress / 100) * 30);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 30 - filled));
  return `${bar} ${progress.stage}${progress.detail ? ` (${progress.detail})` : ''}`;
}

/** Parity of views/ContextUsage. */
export function projectContextUsage(item: Record<string, unknown>): string {
  const modelName = String(item['modelName'] ?? '');
  const totalTokens = Number(item['totalTokens'] ?? 0);
  const windowSize = Number(item['contextWindowSize'] ?? 0);
  const breakdown = (item['breakdown'] ?? {}) as Record<string, number>;
  const isEstimated = Boolean(item['isEstimated']);
  const showDetails = Boolean(item['showDetails']);
  const lines = ['Context Usage', ''];
  if (totalTokens <= 0) {
    lines.push('No API response yet. Send a message to see actual usage.');
    lines.push('Estimated pre-conversation overhead');
  }
  lines.push(
    `Model: ${modelName} Context window: ${fmtTokensShort(windowSize)} tokens`,
  );
  if (totalTokens > 0) {
    if (isEstimated) {
      lines.push('Token usage is estimated until provider usage is received.');
    }
    const free = breakdown['freeSpace'] ?? 0;
    const buffer = breakdown['autocompactBuffer'] ?? 0;
    lines.push('');
    lines.push(
      `█ Used ${fmtTokensShort(totalTokens)} tokens (${pct(totalTokens, windowSize)}%)`,
    );
    lines.push(
      `░ Free ${fmtTokensShort(free)} tokens (${pct(free, windowSize)}%)`,
    );
    lines.push(
      `▒ Autocompact buffer ${fmtTokensShort(buffer)} tokens (${pct(buffer, windowSize)}%)`,
    );
  }
  lines.push('');
  lines.push('Usage by category');
  const categories: Array<[string, string]> = [
    ['System prompt', 'systemPrompt'],
    ['Built-in tools', 'builtinTools'],
    ['MCP tools', 'mcpTools'],
    ['Memory files', 'memoryFiles'],
    ['Skills', 'skills'],
  ];
  for (const [label, key] of categories) {
    const value = breakdown[key] ?? 0;
    if (key === 'mcpTools' && value <= 0) continue;
    lines.push(
      `█ ${label} ${fmtTokensShort(value)} tokens (${pct(value, windowSize)}%)`,
    );
  }
  if (totalTokens > 0) {
    const messages = breakdown['messages'] ?? 0;
    lines.push(
      `█ Messages ${fmtTokensShort(messages)} tokens (${pct(messages, windowSize)}%)`,
    );
  }
  if (!showDetails) {
    lines.push('');
    lines.push('Run /context detail for per-item breakdown.');
  }
  return lines.join('\n');
}

/** Parity of views/DoctorReport. */
export function projectDoctor(
  checks: ReadonlyArray<{
    category: string;
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    detail?: string;
  }>,
  summary: { pass: number; warn: number; fail: number },
): string {
  const lines = ['Doctor Report', ''];
  const categories: string[] = [];
  for (const check of checks) {
    if (!categories.includes(check.category)) categories.push(check.category);
  }
  const icon = (status: string) =>
    status === 'pass' ? '✓' : status === 'warn' ? '⚠' : '✗';
  for (const category of categories) {
    lines.push(category);
    for (const check of checks.filter((c) => c.category === category)) {
      lines.push(` ${icon(check.status)} ${check.name}: ${check.message}`);
      if (check.detail) lines.push(`     -> ${check.detail}`);
    }
    lines.push('');
  }
  lines.push(
    `-- ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failures`,
  );
  return lines.join('\n');
}

/** Parity of views/McpStatus (server status read from the core registry). */
export function projectMcpStatus(item: Record<string, unknown>): string {
  const servers = (item['servers'] ?? {}) as Record<
    string,
    { description?: string; extensionName?: string }
  >;
  const tools = (item['tools'] ?? []) as Array<{
    serverName: string;
    name: string;
    description?: string;
  }>;
  const prompts = (item['prompts'] ?? []) as Array<{
    serverName: string;
    name: string;
  }>;
  const authStatus = (item['authStatus'] ?? {}) as Record<string, string>;
  const blocked = (item['blockedServers'] ?? []) as Array<{
    name: string;
    extensionName?: string;
  }>;
  const showDescriptions = Boolean(item['showDescriptions']);
  const discoveryInProgress = Boolean(item['discoveryInProgress']);
  const connecting = (item['connectingServers'] ?? []) as string[];
  if (Object.keys(servers).length === 0 && blocked.length === 0) {
    return 'No MCP servers configured.';
  }
  const lines: string[] = [];
  if (discoveryInProgress) {
    lines.push(
      `◌ MCP servers are starting up (${connecting.length} initializing)...`,
    );
    lines.push(
      'Note: First startup may take longer. Tool availability will update automatically.',
    );
    lines.push('');
  }
  lines.push('Configured MCP servers:');
  lines.push('');
  const authSuffix = (name: string): string => {
    switch (authStatus[name]) {
      case 'authenticated':
        return ' (OAuth)';
      case 'expired':
        return ' (OAuth expired)';
      case 'unauthenticated':
        return ' (OAuth not authenticated)';
      default:
        return '';
    }
  };
  for (const [name, serverConfig] of Object.entries(servers)) {
    const serverTools = tools.filter((tool) => tool.serverName === name);
    const serverPrompts = prompts.filter((p) => p.serverName === name);
    const from = serverConfig.extensionName
      ? ` (from ${serverConfig.extensionName})`
      : '';
    let status = getMCPServerStatus(name);
    if (
      status === MCPServerStatus.DISCONNECTED &&
      // ink upgrades on cached tools OR cached prompts (hasCachedItems):
      // saved transcripts replay these, so reachability must not flip them
      // to Disconnected.
      (serverTools.length > 0 || serverPrompts.length > 0)
    ) {
      // ink renders cached-item servers as connected
      status = MCPServerStatus.CONNECTED;
    }
    if (status === MCPServerStatus.CONNECTING) {
      lines.push(
        `◐ ${name}${from}... - Starting... (first startup may take longer)${authSuffix(name)}`,
      );
      lines.push(' (tools and prompts will appear when ready)');
    } else if (status === MCPServerStatus.CONNECTED) {
      const parts: string[] = [];
      if (serverTools.length > 0) {
        parts.push(
          `${serverTools.length} ${serverTools.length === 1 ? 'tool' : 'tools'}`,
        );
      }
      if (serverPrompts.length > 0) {
        parts.push(
          `${serverPrompts.length} ${serverPrompts.length === 1 ? 'prompt' : 'prompts'}`,
        );
      }
      lines.push(
        `● ${name}${from} - Ready${parts.length > 0 ? ` (${parts.join(', ')})` : ''}${authSuffix(name)}`,
      );
    } else {
      lines.push(`● ${name}${from}... - Disconnected${authSuffix(name)}`);
      if (serverTools.length > 0) {
        lines.push(`(${serverTools.length} tools cached)`);
      }
    }
    if (showDescriptions && serverConfig.description) {
      lines.push(serverConfig.description.trim());
    }
    if (serverTools.length > 0) {
      lines.push(' Tools:');
      for (const tool of serverTools) {
        lines.push(` - ${tool.name}`);
        if (showDescriptions && tool.description) {
          lines.push(`   ${tool.description.trim()}`);
        }
      }
    }
    if (serverPrompts.length > 0) {
      lines.push(' Prompts:');
      for (const prompt of serverPrompts) {
        lines.push(` - ${prompt.name}`);
      }
    }
    lines.push('');
  }
  for (const server of blocked) {
    const from = server.extensionName ? ` (from ${server.extensionName})` : '';
    lines.push(`● ${server.name}${from} - Blocked`);
  }
  return lines.join('\n').trimEnd();
}

/** Parity of views/ExtensionsList (reads config.getExtensions()). */
export function projectExtensionsList(
  config: Config | null | undefined,
  extensionsUpdateState: Map<string, unknown> | undefined,
): string {
  const extensions = config?.getExtensions?.() ?? [];
  if (extensions.length === 0) return 'No extensions installed.';
  const lines = ['Installed extensions:', ''];
  for (const extension of extensions) {
    const displayName = getExtensionDisplayName(
      extension,
      // getCurrentLanguage is i18n-internal; the list itself is hardcoded
      // English in ink, so the default locale resolution is fine here.
      'en',
    );
    const stateText =
      (extensionsUpdateState?.get(extension.name) as string | undefined) ??
      'unknown state';
    lines.push(
      ` ${displayName} (v${extension.version}) - ${
        extension.isActive ? 'active' : 'disabled'
      } (${stateText})`,
    );
    const resolvedSettings = (
      extension as { resolvedSettings?: Record<string, unknown> }
    ).resolvedSettings;
    if (resolvedSettings && Object.keys(resolvedSettings).length > 0) {
      lines.push(' settings:');
      for (const [name, value] of Object.entries(resolvedSettings)) {
        lines.push(` - ${name}: ${String(value)}`);
      }
    }
  }
  return lines.join('\n');
}

/** Parity of messages/MemorySavedMessage. */
export function projectMemorySaved(
  writtenCount: number,
  verb?: string,
): string {
  return `${verb ?? 'Saved'} ${writtenCount} ${writtenCount === 1 ? 'memory' : 'memories'}`;
}

/** Parity of SessionSummaryDisplay (quit): session summary + resume hint. */
export function projectQuit(
  duration: string,
  stats: SessionStatsState | undefined,
  config: Config | null | undefined,
): string {
  const lines = ['Agent powering down. Goodbye!', ''];
  if (stats) {
    const metrics = stats.metrics;
    const computed = computeSessionStats(metrics);
    lines.push('Interaction Summary');
    lines.push(`Session ID: ${stats.sessionId}`);
    const tools = metrics.tools;
    lines.push(
      `Tool Calls: ${tools.totalCalls} ( ✓ ${tools.totalSuccess} ✗ ${tools.totalFail} )`,
    );
    lines.push(`Success Rate: ${computed.successRate.toFixed(1)}%`);
    if (computed.totalDecisions > 0) {
      lines.push(
        `User Agreement: ${computed.agreementRate.toFixed(1)}% (${computed.totalDecisions} reviewed)`,
      );
    }
    if (computed.totalLinesAdded > 0 || computed.totalLinesRemoved > 0) {
      lines.push(
        `Code Changes: +${computed.totalLinesAdded} -${computed.totalLinesRemoved}`,
      );
    }
    lines.push('');
    lines.push('Performance');
    lines.push(`Wall Time: ${duration}`);
    lines.push(`Agent Active: ${formatDuration(computed.agentActiveTime)}`);
    lines.push(
      `» API Time: ${formatDuration(computed.totalApiTime)} (${computed.apiTimePercent.toFixed(1)}%)`,
    );
    lines.push(
      `» Tool Time: ${formatDuration(computed.totalToolTime)} (${computed.toolTimePercent.toFixed(1)}%)`,
    );
    const entries = flattenActiveModels(metrics);
    if (entries.length > 0) {
      lines.push('');
      lines.push('Model Usage');
      for (const entry of entries) {
        lines.push(
          `${entry.label}: ${entry.metrics.api.totalRequests} requests, ` +
            `${entry.metrics.tokens.prompt.toLocaleString()} input tokens, ` +
            `${entry.metrics.tokens.candidates.toLocaleString()} output tokens`,
        );
      }
      if (computed.cacheEfficiency > 0) {
        lines.push('');
        lines.push(
          `Savings Highlight: ${computed.totalCachedTokens.toLocaleString()} ` +
            `(${computed.cacheEfficiency.toFixed(1)}%) of input tokens were served from the cache, reducing costs.`,
        );
      }
    }
    lines.push('');
    lines.push('» Tip: For a full token breakdown, run `/stats model`.');
  } else {
    lines.push(`Session duration: ${duration}`);
  }
  if (stats && stats.promptCount > 0 && config?.getChatRecordingService?.()) {
    lines.push('');
    lines.push(
      `To continue this session, run qwen --resume ${stats.sessionId}`,
    );
  }
  return lines.join('\n');
}

/** Parity of messages/BtwMessage. */
export function projectBtw(btw: {
  question: string;
  answer: string;
  isPending?: boolean;
}): string {
  const lines = [`/btw ${btw.question}`, ''];
  if (btw.isPending) {
    lines.push('+ Answering...');
  } else {
    lines.push(btw.answer);
  }
  return lines.join('\n');
}

/** Extract a plain-text prompt from a confirm_action ReactNode prompt. */
export function extractPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (typeof prompt === 'number') return String(prompt);
  if (prompt && typeof prompt === 'object') {
    const props = (prompt as { props?: { children?: unknown } }).props;
    if (props && 'children' in props) {
      const children = props.children;
      if (Array.isArray(children)) {
        return children.map((child) => extractPromptText(child)).join('');
      }
      return extractPromptText(children);
    }
  }
  return '';
}

/**
 * Projects one special history item to text; null when the item kind has no
 * transcript rendering (dialog payloads, tool groups, …).
 */
export function projectSpecialItemText(
  item: HistoryItemWithoutId,
  ctx: ItemProjectionContext,
): string | null {
  const record = item as unknown as Record<string, unknown>;
  switch (item.type) {
    case 'about':
      return projectAbout(
        (record['systemInfo'] ?? {}) as Record<string, unknown>,
      );
    case 'tools_list':
      return projectToolsList(
        ((record['tools'] ?? []) as Array<{
          name: string;
          displayName?: string;
          description?: string;
        }>) ?? [],
        Boolean(record['showDescriptions']),
      );
    case 'model_stats': {
      const metrics = ctx.stats?.metrics ?? uiTelemetryService.getMetrics();
      // ink reads the pricing table from settings.merged.modelPricing
      // (useSettings); the old probe of config.getModelPricing() hit a
      // method that does not exist, so pricing never resolved.
      const modelPricing = ctx.settings?.merged?.modelPricing;
      return projectModelStats(metrics, modelPricing);
    }
    case 'tool_stats':
      return projectToolStats(
        ctx.stats?.metrics ?? uiTelemetryService.getMetrics(),
      );
    case 'skill_stats':
      return projectSkillStats(
        ctx.stats?.metrics ?? uiTelemetryService.getMetrics(),
      );
    case 'summary':
      return projectSummary(
        (record['summary'] ?? {}) as Parameters<typeof projectSummary>[0],
      );
    case 'insight_progress':
      return projectInsightProgress(
        (record['progress'] ?? {}) as Parameters<
          typeof projectInsightProgress
        >[0],
      );
    case 'context_usage':
      return projectContextUsage(record);
    case 'doctor':
      return projectDoctor(
        (record['checks'] ?? []) as Parameters<typeof projectDoctor>[0],
        (record['summary'] ?? { pass: 0, warn: 0, fail: 0 }) as {
          pass: number;
          warn: number;
          fail: number;
        },
      );
    case 'mcp_status':
      return projectMcpStatus(record);
    case 'extensions_list':
      return projectExtensionsList(ctx.config, ctx.extensionsUpdateState);
    case 'skills_list':
      return projectSkillsList(
        (record['skills'] ?? []) as Parameters<typeof projectSkillsList>[0],
      );
    case 'memory_saved':
      return projectMemorySaved(
        Number(record['writtenCount'] ?? 0),
        record['verb'] as string | undefined,
      );
    case 'quit':
      return projectQuit(
        String(record['duration'] ?? ''),
        ctx.stats,
        ctx.config,
      );
    case 'btw': {
      const btw = record['btw'] as Parameters<typeof projectBtw>[0] | undefined;
      return btw ? projectBtw(btw) : null;
    }
    default:
      return null;
  }
}
