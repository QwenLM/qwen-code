/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ToolSearch — discovery tool for on-demand loading of deferred tool schemas.
 *
 * Only a curated set of core tools are included in the initial
 * function-declaration list sent to the model; tools marked `shouldDefer=true`
 * (MCP tools, low-frequency built-ins) are hidden to keep the system prompt
 * small. The model uses this tool to look up those hidden tools by keyword or
 * exact name, which loads their full schemas into the next API request.
 *
 * Two query modes:
 *   - `select:Name1,Name2` — exact lookup by tool name
 *   - free-text keywords — fuzzy match with scoring across name, description,
 *     and optional `searchHint`. MCP tools get a slight score boost since
 *     they are always deferred and thus always benefit from surfacing.
 */

import type {
  AnyDeclarativeTool,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TOOL_SEARCH');

export interface ToolSearchParams {
  query: string;
  max_results?: number;
}

const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 20;

// Scoring weights mirror the Claude Code spec: MCP tools are weighted slightly
// higher because they are always deferred and discovery is the only way the
// model can reach them.
const SCORE_NAME_EXACT_BUILTIN = 10;
const SCORE_NAME_SUBSTR_BUILTIN = 5;
const SCORE_HINT_BUILTIN = 4;
const SCORE_DESC_BUILTIN = 2;
const SCORE_NAME_EXACT_MCP = 12;
const SCORE_NAME_SUBSTR_MCP = 6;

interface ScoredTool {
  tool: AnyDeclarativeTool;
  score: number;
}

const toolSearchDescription = `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in the "Deferred Tools" section of the system prompt. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Query forms:
- "select:ToolA,ToolB" — fetch these exact tools by name
- "keyword phrase" — keyword search, up to max_results best matches
- "+must-word other" — require "must-word" in the name, rank remaining terms
`;

class ToolSearchInvocation extends BaseToolInvocation<
  ToolSearchParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ToolSearchParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return this.params.query;
  }

  async execute(): Promise<ToolResult> {
    const query = (this.params.query ?? '').trim();
    if (!query) {
      return {
        llmContent:
          'Error: query is empty. Use `select:ToolName` or free-text keywords.',
        returnDisplay: 'Empty query',
        error: { message: 'Empty query' },
      };
    }

    const maxResults = clamp(
      this.params.max_results ?? DEFAULT_MAX_RESULTS,
      1,
      HARD_MAX_RESULTS,
    );

    // Mode 1: exact lookup via `select:Name1,Name2`. Dedupe so the same tool
    // isn't returned multiple times when the model writes the same name twice.
    if (query.toLowerCase().startsWith('select:')) {
      const seen = new Set<string>();
      const names: string[] = [];
      for (const raw of query.slice('select:'.length).split(',')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(trimmed);
      }
      return this.loadAndReturnSchemas(names);
    }

    // Mode 2: keyword search. Require-word prefix with "+" boosts mandatory
    // terms; any tool missing a required term is excluded before scoring.
    const terms = tokenize(query);
    const requiredTerms = terms
      .filter((t) => t.startsWith('+'))
      .map((t) => t.slice(1))
      .filter((t) => t.length > 0);
    const searchTerms = terms
      .map((t) => (t.startsWith('+') ? t.slice(1) : t))
      .filter((t) => t.length > 0);

    if (searchTerms.length === 0) {
      return {
        llmContent:
          'Error: no search terms extracted from query. Use `select:ToolName` or include keywords.',
        returnDisplay: 'No search terms',
        error: { message: 'No search terms' },
      };
    }

    const candidates = this.collectCandidates();
    const scored: ScoredTool[] = [];
    for (const tool of candidates) {
      if (!candidateMatchesRequired(tool, requiredTerms)) continue;
      const score = scoreTool(tool, searchTerms);
      if (score > 0) scored.push({ tool, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.tool.name.localeCompare(b.tool.name);
    });

    const matches = scored.slice(0, maxResults).map((s) => s.tool.name);
    if (matches.length === 0) {
      return {
        llmContent: `No tools found matching '${query}'. Try broader keywords or use \`select:ToolName\`.`,
        returnDisplay: `No matches for '${query}'`,
      };
    }
    return this.loadAndReturnSchemas(matches);
  }

  /**
   * Candidates for keyword search: only deferred tools. Already-loaded (core)
   * tools are already in the model's tool-declaration list, so surfacing them
   * here would be noise. `select:<name>` mode is unrestricted — the model may
   * legitimately want to inspect the schema of an already-loaded tool — and
   * handles its own lookup via {@link loadAndReturnSchemas}.
   */
  private collectCandidates(): AnyDeclarativeTool[] {
    const registry = this.config.getToolRegistry();
    return registry.getAllTools().filter((t) => t.shouldDefer && !t.alwaysLoad);
  }

  private async loadAndReturnSchemas(names: string[]): Promise<ToolResult> {
    if (names.length === 0) {
      return {
        llmContent: 'Error: no tool names provided.',
        returnDisplay: 'No tool names',
        error: { message: 'No tool names' },
      };
    }

    const registry = this.config.getToolRegistry();
    const loaded: AnyDeclarativeTool[] = [];
    const missing: string[] = [];

    // Case-insensitive lookup across all known names (instance names + factory
    // names). Preserve the user-supplied casing in the error list so the
    // response matches what the model asked for.
    const lowerIndex = new Map<string, string>();
    for (const realName of registry.getAllToolNames()) {
      lowerIndex.set(realName.toLowerCase(), realName);
    }

    for (const requested of names) {
      const canonical = lowerIndex.get(requested.toLowerCase());
      if (!canonical) {
        missing.push(requested);
        continue;
      }
      const tool = await registry.ensureTool(canonical);
      if (!tool) {
        missing.push(requested);
        continue;
      }
      registry.revealDeferredTool(canonical);
      loaded.push(tool);
    }

    // Re-sync the active chat's tool list so the revealed tools appear in the
    // next API request. Safe to call even if the client hasn't initialised.
    if (loaded.length > 0) {
      try {
        await this.config.getGeminiClient()?.setTools();
      } catch (err) {
        // Non-fatal for this call — the schemas still appear in llmContent
        // below so the model can read them. But the chat's declaration list
        // didn't update, so follow-up calls to the revealed tools may fail
        // at the API layer. Log for diagnostics.
        debugLogger.warn(
          'setTools() failed while revealing deferred tools; chat tool list may be stale until next session:',
          err,
        );
      }
    }

    const schemaBlocks = loaded.map(
      (tool) => `<function>${JSON.stringify(tool.schema)}</function>`,
    );
    let llmContent = '';
    if (schemaBlocks.length > 0) {
      llmContent += `<functions>\n${schemaBlocks.join('\n')}\n</functions>`;
    }
    if (missing.length > 0) {
      const header = llmContent ? '\n\n' : '';
      llmContent += `${header}Not found: ${missing.join(', ')}`;
    }

    const displayParts: string[] = [];
    if (loaded.length > 0) displayParts.push(`Loaded ${loaded.length} tool(s)`);
    if (missing.length > 0) displayParts.push(`${missing.length} missing`);
    const returnDisplay = displayParts.join(', ') || 'No tools loaded';

    return { llmContent, returnDisplay };
  }
}

export class ToolSearchTool extends BaseDeclarativeTool<
  ToolSearchParams,
  ToolResult
> {
  static readonly Name = ToolNames.TOOL_SEARCH;

  constructor(private readonly config: Config) {
    super(
      ToolSearchTool.Name,
      ToolDisplayNames.TOOL_SEARCH,
      toolSearchDescription,
      Kind.Other,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      false, // shouldDefer — this tool itself must always be visible
      true, // alwaysLoad — core discovery tool, never hidden
      'tool search discover find schema',
    );
  }

  protected createInvocation(
    params: ToolSearchParams,
  ): ToolInvocation<ToolSearchParams, ToolResult> {
    return new ToolSearchInvocation(this.config, params);
  }
}

// ---------- pure helpers (exported for tests) ----------

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function candidateMatchesRequired(
  tool: AnyDeclarativeTool,
  requiredTerms: string[],
): boolean {
  if (requiredTerms.length === 0) return true;
  const nameLower = tool.name.toLowerCase();
  return requiredTerms.every((t) => nameLower.includes(t));
}

/**
 * Score a tool against the search terms. Returns 0 if no signal matched; the
 * caller filters by `> 0`.
 */
export function scoreTool(tool: AnyDeclarativeTool, terms: string[]): number {
  const isMcp = tool instanceof DiscoveredMCPTool;
  const nameLower = tool.name.toLowerCase();
  const descLower = (tool.description ?? '').toLowerCase();
  const hintLower = (tool.searchHint ?? '').toLowerCase();
  const hintParts = hintLower ? hintLower.split(/\s+/g).filter(Boolean) : [];

  let total = 0;
  for (const term of terms) {
    if (term.length === 0) continue;
    if (
      nameLower === term ||
      nameLower.endsWith('_' + term) ||
      nameLower.endsWith('.' + term)
    ) {
      total += isMcp ? SCORE_NAME_EXACT_MCP : SCORE_NAME_EXACT_BUILTIN;
    } else if (nameLower.includes(term)) {
      total += isMcp ? SCORE_NAME_SUBSTR_MCP : SCORE_NAME_SUBSTR_BUILTIN;
    }
    // Hint matches are per-word, mirroring Claude's "word boundary" rule.
    if (hintParts.some((p) => p === term)) {
      total += SCORE_HINT_BUILTIN;
    }
    if (descLower.includes(term)) {
      total += SCORE_DESC_BUILTIN;
    }
  }
  return total;
}
