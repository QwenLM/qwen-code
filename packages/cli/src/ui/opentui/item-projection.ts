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
  CompressionStatus,
  findProviderByCredentials,
  getExtensionDisplayName,
  getMCPServerStatus,
  MCPServerStatus,
  resolveMetadataKey,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';
import type {
  Config,
  SessionMetrics,
  SkillLevel,
} from '@qwen-code/qwen-code-core';
import type { HistoryItemWithoutId } from '../types.js';
import { flattenModelsBySource } from '../utils/modelsBySource.js';
import { calculateCost } from '../../utils/costCalculator.js';
import { computeSessionStats } from '../utils/computeStats.js';
import { formatDuration } from '../utils/formatters.js';
import { levelLabel } from '../utils/skill-level-label.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import { redactProxy } from '../systemInfoFields.js';

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
  // ink's formatBaseUrl hides the line unless BOTH the auth type and the
  // base URL are present (systemInfoFields.ts).
  if (!isOAuth && selectedAuthType && baseUrl) {
    addField('Base URL', baseUrl);
  }
  const modelVersion = String(systemInfo['modelVersion'] ?? '');
  addField('Model', modelVersion);
  addField('Fast Model', String(systemInfo['fastModel'] ?? '') || modelVersion);
  addField('Session ID', String(systemInfo['sessionId'] ?? ''));
  addField('Sandbox', String(systemInfo['sandboxEnv'] ?? ''));
  const proxy = systemInfo['proxy'] as string | undefined;
  if (proxy) {
    addField('Proxy', redactProxy(proxy));
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
  skills: ReadonlyArray<{
    name: string;
    description?: string;
    level?: SkillLevel;
  }>,
): string {
  const lines = ['Available skills:', ''];
  if (skills.length === 0) {
    lines.push(' No skills available');
    return lines.join('\n');
  }
  // ink's SkillsList truncate keeps the total length at n (slice to n-1
  // plus the ellipsis), not n+1 — the description column must not shift.
  const truncate = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
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

/** Per-entry cost: ink looks pricing up under the RAW model name from the
 * structured key (ModelStatsDisplay getModelName); the display label is
 * normalized and may carry a ` (source)` suffix that never matches. */
function entryCost(
  entry: FlatModelEntry,
  modelPricing?: Record<string, unknown>,
): number | null {
  return calculateCost({
    inputTokens: entry.metrics.tokens.prompt,
    outputTokens:
      entry.metrics.tokens.candidates + entry.metrics.tokens.thoughts,
    pricing: (modelPricing ?? {})[entry.key.split('::')[0]] as Parameters<
      typeof calculateCost
    >[0]['pricing'],
  });
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
  // ink's ModelStatsDisplay renders one column per (model, source) entry
  // with per-model values and N/A for unpriced models; collapsing entries
  // into one set of session totals describes neither model, dilutes the
  // failing model's error rate, and silently excludes unpriced models from
  // a single Estimated figure.
  const hasPricing = entries.some(
    (entry) => entryCost(entry, modelPricing) != null,
  );
  const lines = ['Model Stats For Nerds', ''];
  for (const entry of entries) {
    const m = entry.metrics;
    lines.push(entry.label);
    lines.push('API');
    lines.push(`Requests ${m.api.totalRequests.toLocaleString()}`);
    lines.push(
      `Errors ${m.api.totalErrors.toLocaleString()} (${m.api.totalRequests > 0 ? ((m.api.totalErrors / m.api.totalRequests) * 100).toFixed(1) : '0.0'}%)`,
    );
    lines.push(
      `Avg Latency ${m.api.totalRequests > 0 ? formatDuration(m.api.totalLatencyMs / m.api.totalRequests) : '0s'}`,
    );
    lines.push('Tokens');
    lines.push(`Total ${m.tokens.total.toLocaleString()}`);
    lines.push(` ↳ Prompt ${m.tokens.prompt.toLocaleString()}`);
    if (m.tokens.cached > 0) {
      lines.push(
        ` ↳ Cached ${m.tokens.cached.toLocaleString()} (${pct(m.tokens.cached, m.tokens.prompt)}%)`,
      );
    }
    if (m.tokens.thoughts > 0) {
      lines.push(` ↳ Thoughts ${m.tokens.thoughts.toLocaleString()}`);
    }
    lines.push(` ↳ Output ${m.tokens.candidates.toLocaleString()}`);
    if (hasPricing) {
      const cost = entryCost(entry, modelPricing);
      lines.push('Cost');
      lines.push(`Estimated ${cost != null ? `$${cost.toFixed(4)}` : 'N/A'}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
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
  const breakdown = (item['breakdown'] ?? {}) as Record<string, unknown>;
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
    const free = Number(breakdown['freeSpace'] ?? 0);
    const buffer = Number(breakdown['autocompactBuffer'] ?? 0);
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
    const value = Number(breakdown[key] ?? 0);
    if (key === 'mcpTools' && value <= 0) continue;
    lines.push(
      `█ ${label} ${fmtTokensShort(value)} tokens (${pct(value, windowSize)}%)`,
    );
  }
  if (totalTokens > 0) {
    const messages = Number(breakdown['messages'] ?? 0);
    lines.push(
      `█ Messages ${fmtTokensShort(messages)} tokens (${pct(messages, windowSize)}%)`,
    );
  }
  // Three-tier compaction ladder — ink renders it whenever thresholds +
  // currentTier are present (even while usage is still estimated).
  const thresholds = breakdown['thresholds'] as
    | { effectiveWindow: number; warn: number; auto: number; hard: number }
    | undefined;
  const currentTier = breakdown['currentTier'] as string | undefined;
  if (thresholds && currentTier) {
    lines.push('');
    lines.push('Compaction thresholds');
    const tierRows: Array<[string, number, string]> = [
      ['Effective window', thresholds.effectiveWindow, ''],
      ['Warn threshold', thresholds.warn, 'warn'],
      ['Auto threshold', thresholds.auto, 'auto'],
      ['Hard threshold', thresholds.hard, 'hard'],
    ];
    for (const [label, tokens, tier] of tierRows) {
      const marker = tier && currentTier === tier ? '▶' : ' ';
      lines.push(`${marker} ${label} ${fmtTokensShort(tokens)} tokens`);
    }
    lines.push(`  Current tier ${currentTier}`);
  }
  if (showDetails) {
    const byTokens = (a: { tokens: number }, b: { tokens: number }) =>
      b.tokens - a.tokens;
    const detail = (
      title: string,
      entries: ReadonlyArray<{ name: string; tokens: number }>,
    ): void => {
      if (entries.length === 0) return;
      lines.push('');
      lines.push(title);
      for (const entry of entries) {
        const name =
          entry.name.length > 30 ? `${entry.name.slice(0, 29)}…` : entry.name;
        lines.push(
          `  └ ${name.padEnd(30)} ${fmtTokensShort(entry.tokens)} tokens`,
        );
      }
    };
    detail(
      'Built-in tools',
      [
        ...((item['builtinTools'] ?? []) as Array<{
          name: string;
          tokens: number;
        }>),
      ].sort(byTokens),
    );
    detail(
      'MCP tools',
      [
        ...((item['mcpTools'] ?? []) as Array<{
          name: string;
          tokens: number;
        }>),
      ].sort(byTokens),
    );
    detail(
      'Memory files',
      // The producer emits ContextMemoryDetail ({ path, tokens }); map to
      // the name field detail() renders.
      [
        ...((item['memoryFiles'] ?? []) as Array<{
          path: string;
          tokens: number;
        }>),
      ]
        .map((file) => ({ name: file.path, tokens: file.tokens }))
        .sort(byTokens),
    );
    const skills = [
      ...((item['skills'] ?? []) as Array<{
        name: string;
        tokens: number;
        loaded?: boolean;
        bodyTokens?: number;
      }>),
    ];
    // Loaded skills first, then by total (listing + body) token cost.
    skills.sort((a, b) => {
      if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
      const aTotal = a.tokens + (a.bodyTokens ?? 0);
      const bTotal = b.tokens + (b.bodyTokens ?? 0);
      return bTotal - aTotal;
    });
    if (skills.length > 0) {
      lines.push('');
      lines.push('Skills');
      for (const skill of skills) {
        const name =
          skill.name.length > 30 ? `${skill.name.slice(0, 29)}…` : skill.name;
        const suffix = skill.loaded
          ? ` (+${fmtTokensShort(skill.bodyTokens ?? 0)} body)`
          : '';
        lines.push(
          `  ${skill.loaded ? '*' : ' '} ${name.padEnd(28)} ${fmtTokensShort(skill.tokens)} tokens${suffix}`,
        );
      }
    }
  } else {
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
    schema?: { parametersJsonSchema?: unknown; parameters?: unknown };
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
  const showSchema = Boolean(item['showSchema']);
  const showTips = Boolean(item['showTips']);
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
        `◐ ${name}${from} - Starting... (first startup may take longer)${authSuffix(name)}`,
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
      lines.push(`● ${name}${from} - Disconnected${authSuffix(name)}`);
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
        // ink's /mcp schema view prints the parameter JSON under each tool.
        const schemaContent =
          showSchema &&
          tool.schema &&
          (tool.schema.parametersJsonSchema || tool.schema.parameters)
            ? JSON.stringify(
                tool.schema.parametersJsonSchema ?? tool.schema.parameters,
                null,
                2,
              )
            : null;
        if (schemaContent) {
          lines.push('     Parameters:');
          for (const line of schemaContent.split('\n')) {
            lines.push(`     ${line}`);
          }
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
  if (showTips) {
    lines.push('');
    lines.push('★ Tips:');
    lines.push('  - Use /mcp desc to show server and tool descriptions');
    lines.push('  - Use /mcp schema to show tool parameter schemas');
    lines.push('  - Use /mcp nodesc to hide descriptions');
    lines.push('  - Use /mcp to authenticate with OAuth-enabled servers');
    lines.push('  - Press Ctrl+T to toggle tool descriptions on/off');
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
    if (extension.resolvedSettings && extension.resolvedSettings.length > 0) {
      lines.push(' settings:');
      for (const setting of extension.resolvedSettings) {
        lines.push(` - ${setting.name}: ${setting.value}`);
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

/** Parity of messages/CompressionMessage. */
export function projectCompression(compression: {
  isPending?: boolean;
  originalTokenCount?: number | null;
  newTokenCount?: number | null;
  compressionStatus?: CompressionStatus | null;
  originalTokenCountIsEstimated?: boolean;
  newTokenCountIsEstimated?: boolean;
}): string {
  if (compression.isPending) {
    return 'Compressing chat history';
  }
  // Estimated counts (#9309): a '~' prefix marks which banner numbers are
  // local estimates rather than API-reported counts.
  const formatTokens = (count: number, isEstimated?: boolean) =>
    isEstimated ? `~${count}` : String(count);
  const original = compression.originalTokenCount ?? 0;
  const next = compression.newTokenCount ?? 0;
  switch (compression.compressionStatus) {
    case CompressionStatus.COMPRESSED:
      return `Chat history compressed from ${formatTokens(
        original,
        compression.originalTokenCountIsEstimated,
      )} to ${formatTokens(
        next,
        compression.newTokenCountIsEstimated,
      )} tokens.`;
    case CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT:
      // For smaller histories (< 50k tokens), compression overhead likely
      // exceeds benefits; larger ones suggest a compression-prompt issue.
      return original < 50000
        ? 'Compression was not beneficial for this history size.'
        : 'Chat history compression did not reduce size. This may indicate issues with the compression prompt.';
    case CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR:
      return 'Could not compress chat history due to a token counting error.';
    case CompressionStatus.NOOP:
      return 'Nothing to compress.';
    default:
      return '';
  }
}

/** Shared body of the quit summary and the `/stats` StatsDisplay. */
function renderStatsSections(
  duration: string,
  stats: SessionStatsState,
): string[] {
  const lines: string[] = [];
  const metrics = stats.metrics;
  const computed = computeSessionStats(metrics);
  lines.push('Interaction Summary');
  lines.push(`Session ID: ${stats.sessionId}`);
  const tools = metrics.tools;
  lines.push(
    `Tool Calls: ${tools.totalCalls} ( ✓ ${tools.totalSuccess} x ${tools.totalFail} )`,
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
      // ink renders the /stats-model tip only inside this savings block
      // (StatsDisplay ModelUsageTable), so it disappears with the block.
      lines.push('');
      lines.push('» Tip: For a full token breakdown, run `/stats model`.');
    }
  }
  return lines;
}

/** Parity of SessionSummaryDisplay (quit): session summary + resume hint. */
export function projectQuit(
  duration: string,
  stats: SessionStatsState | undefined,
  config: Config | null | undefined,
): string {
  const lines = ['Agent powering down. Goodbye!', ''];
  if (stats) {
    lines.push(...renderStatsSections(duration, stats));
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

/** Parity of StatsDisplay (the `/stats` history item). */
export function projectStats(
  duration: string,
  stats: SessionStatsState | undefined,
): string {
  const lines = ['Session Stats', ''];
  if (stats) {
    lines.push(...renderStatsSections(duration, stats));
  } else {
    lines.push(`Session duration: ${duration}`);
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
    case 'compression':
      return projectCompression(
        (record['compression'] ?? {}) as Parameters<
          typeof projectCompression
        >[0],
      );
    case 'stats':
      return projectStats(String(record['duration'] ?? ''), ctx.stats);
    case 'btw': {
      const btw = record['btw'] as Parameters<typeof projectBtw>[0] | undefined;
      return btw ? projectBtw(btw) : null;
    }
    case 'info': {
      // ink's InfoMessage renders linkUrl/linkText as a footer link (the
      // URL prints when the terminal cannot render links), so headless/SSH
      // users can still recover it (/bug).
      const text = typeof record['text'] === 'string' ? record['text'] : null;
      const linkUrl =
        typeof record['linkUrl'] === 'string' ? record['linkUrl'] : null;
      if (!text) return null;
      if (!linkUrl) return text;
      const linkText =
        typeof record['linkText'] === 'string' && record['linkText']
          ? `${record['linkText']}: `
          : '';
      return `${text}\n${linkText}${linkUrl}`;
    }
    case 'warning':
    case 'success':
      return typeof record['text'] === 'string' ? record['text'] : null;
    case 'error': {
      // ErrorMessage renders text + an optional secondary-color hint.
      const hint =
        typeof record['hint'] === 'string' && record['hint']
          ? `\n${record['hint']}`
          : '';
      return typeof record['text'] === 'string' ? record['text'] + hint : null;
    }
    default:
      return null;
  }
}
