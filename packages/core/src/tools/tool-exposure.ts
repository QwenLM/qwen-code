/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolExposureHints } from '../codemode/types.js';
import { MCP_TOOL_PREFIX } from '../mcp/tools/mcp-names.js';
import type { CodeModeExposure } from '../codemode/settings.js';

/**
 * How one agent sees a tool:
 * - declared: sent to the model;
 * - inline: callable only through CodeMode, signature inlined in its description;
 * - deferred: callable only through CodeMode, found by script discovery;
 * - meta: reached through mcp_call by an agent without CodeMode;
 * - hidden: neither declared nor callable by this agent.
 */
export type ToolExposure = 'declared' | 'inline' | 'deferred' | 'meta' | 'hidden';

export interface ExposureTool {
  readonly name: string;
  readonly exposureHints: ToolExposureHints;
}

export interface ExposureContext {
  /** `codeMode.deferredTools`: names or `*` patterns; a leading `!` keeps a tool declared. */
  patterns: readonly string[];
  /** CodeMode replaces MCP lazy loading and defers MCP tools outside declaredMcpServers. */
  mcpViaCodeMode: boolean;
  /** Servers whose tools this session keeps declared because they fit the threshold. */
  declaredMcpServers?: ReadonlySet<string>;
  /** This agent's CodeMode exposure; undefined when the agent has no CodeMode. */
  codeMode?: CodeModeExposure;
  /** This agent declares mcp_call, the path to deferred MCP tools without CodeMode. */
  metaCall: boolean;
}

interface CompiledPatterns {
  include: RegExp[];
  exclude: RegExp[];
}

const compiledPatterns = new WeakMap<readonly string[], CompiledPatterns>();

function toRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function compile(patterns: readonly string[]): CompiledPatterns {
  let compiled = compiledPatterns.get(patterns);
  if (compiled) return compiled;
  compiled = { include: [], exclude: [] };
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.startsWith('!')) {
      if (pattern.length > 1) compiled.exclude.push(toRegExp(pattern.slice(1)));
    } else if (pattern) compiled.include.push(toRegExp(pattern));
  }
  compiledPatterns.set(patterns, compiled);
  return compiled;
}

type DeferralContext = Pick<
  ExposureContext,
  'patterns' | 'mcpViaCodeMode' | 'declaredMcpServers'
>;

function isDeferred(tool: ExposureTool, context: DeferralContext): boolean {
  const hints = tool.exposureHints;
  if (hints.pinned) return false;
  const { include, exclude } = compile(context.patterns);
  if (exclude.some((pattern) => pattern.test(tool.name))) return false;
  if (include.some((pattern) => pattern.test(tool.name))) return true;
  if (
    hints.namespace?.kind === 'mcp' &&
    context.mcpViaCodeMode &&
    !context.declaredMcpServers?.has(hints.namespace.server)
  )
    return true;
  return hints.defaultDeferred === true;
}

/** Whether CodeMode scripts may call the tool; meta tools only serve agents without CodeMode. */
export function isScriptCallable(
  tool: Pick<ExposureTool, 'exposureHints'>,
): boolean {
  return !tool.exposureHints.modelOnly && !tool.exposureHints.metaTool;
}

/**
 * Whether an MCP tool leaves the declarations for CodeMode scripts or mcp_call.
 * Model-only tools stay declared because scripts could not call them.
 */
export function isDeferredMcpTool(
  tool: ExposureTool,
  context: DeferralContext,
): boolean {
  return (
    isScriptCallable(tool) &&
    tool.exposureHints.namespace?.kind === 'mcp' &&
    isDeferred(tool, context)
  );
}

/** Whether a name allow-list keeps a tool; a companion follows the tool it serves. */
export function isKeptByAllowList(
  tool: Pick<ExposureTool, 'name' | 'exposureHints'>,
  allowed: ReadonlySet<string>,
): boolean {
  const primary = tool.exposureHints.companionOf;
  return (
    allowed.has(tool.name) || (primary !== undefined && allowed.has(primary))
  );
}

/** The single exposure decision; the first matching rule decides. */
export function resolveExposure(
  tool: ExposureTool,
  context: ExposureContext,
): ToolExposure {
  const hints = tool.exposureHints;
  if (hints.metaTool) return context.codeMode ? 'hidden' : 'declared';
  // Hiding a tool that scripts cannot call would make it unreachable.
  if (hints.modelOnly) return 'declared';
  const deferred = isDeferred(tool, context);
  if (context.codeMode === 'only')
    return deferred || hints.namespace ? 'deferred' : 'inline';
  if (context.codeMode) return deferred ? 'deferred' : 'declared';
  return context.metaCall && isDeferredMcpTool(tool, context)
    ? 'meta'
    : 'declared';
}

export interface McpRegistration {
  /** lazy registers only alwaysLoad tools; full registers every MCP tool. */
  mode: 'lazy' | 'full';
  mcpViaCodeMode: boolean;
  declaredMcpServers: ReadonlySet<string>;
}

const NO_SERVERS: ReadonlySet<string> = new Set();

/** With CodeMode, scripts discover and call every MCP tool; the lazy preference applies only without it. */
export function resolveMcpRegistration(
  codeMode: CodeModeExposure | undefined,
  lazyLoad: boolean,
): McpRegistration {
  const mcpViaCodeMode = codeMode !== undefined;
  return {
    mode: lazyLoad && !mcpViaCodeMode ? 'lazy' : 'full',
    mcpViaCodeMode,
    declaredMcpServers: NO_SERVERS,
  };
}

const DEFAULT_MCP_DEFER_THRESHOLD = 10;

/** `codeMode.mcpDeferThreshold`: percent of the context window; 0 always defers. */
export function readMcpDeferThreshold(codeMode: unknown): number {
  const value =
    codeMode && typeof codeMode === 'object'
      ? (codeMode as { mcpDeferThreshold?: unknown }).mcpDeferThreshold
      : undefined;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : DEFAULT_MCP_DEFER_THRESHOLD;
}

/** Declarations must stay below this many tokens to be declared; undefined when MCP tools always defer. */
export function mcpDeclarationBudget(
  codeMode: CodeModeExposure | undefined,
  threshold: number,
  contextWindow: number | undefined,
): number | undefined {
  return codeMode === 'on' && threshold > 0 && contextWindow !== undefined
    ? (contextWindow * threshold) / 100
    : undefined;
}

/** Reads `codeMode.deferredTools`, ignoring malformed entries. */
export function readDeferredToolPatterns(codeMode: unknown): readonly string[] {
  if (!codeMode || typeof codeMode !== 'object') return NO_PATTERNS;
  const value = (codeMode as { deferredTools?: unknown }).deferredTools;
  if (!Array.isArray(value)) return NO_PATTERNS;
  const patterns = value.filter(
    (item): item is string => typeof item === 'string',
  );
  return patterns.length === value.length ? value : patterns;
}

const NO_PATTERNS: readonly string[] = Object.freeze([]);

/** Whether a pattern may defer MCP tools; decides wording before servers connect. */
export function patternsMayDeferMcp(patterns: readonly string[]): boolean {
  return patterns.some((raw) => {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('!')) return false;
    const literal = pattern.split('*')[0];
    return (
      MCP_TOOL_PREFIX.startsWith(literal) || literal.startsWith(MCP_TOOL_PREFIX)
    );
  });
}

/** Exact names in the settings that resolve to registered model-only tools. */
export function ineffectiveDeferredNames(
  patterns: readonly string[],
  tools: readonly ExposureTool[],
): string[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return patterns.filter((pattern) => {
    if (pattern.includes('*') || pattern.startsWith('!')) return false;
    const tool = byName.get(pattern.trim());
    return !!tool?.exposureHints.modelOnly;
  });
}
