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

const toolSearchDescription = `Fetches function declarations for deferred tools and registers them with the active session so subsequent turns can call them.

Deferred tools appear by name in the "Deferred Tools" section of the system prompt. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' function declarations (name + description + parameter schema) inside a <functions> block.

The returned <functions> block is informational — it shows what the schema looks like. Calling the tool itself happens via the model's normal function-call mechanism on the NEXT turn, after the active session's declaration list has been updated. Tools fetched here remain available for the rest of the session.

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

  async execute(_signal: AbortSignal): Promise<ToolResult> {
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
    // Cap at maxResults — without a cap, `select:a,b,c,...` would return
    // an unbounded number of full schemas (token bloat). When truncation
    // happens, surface the dropped names in the result so the model knows
    // to re-issue another ToolSearch for them instead of silently
    // assuming they were loaded.
    if (query.toLowerCase().startsWith('select:')) {
      const seen = new Set<string>();
      const names: string[] = [];
      const truncated: string[] = [];
      for (const raw of query.slice('select:'.length).split(',')) {
        // The deferred-tools system prompt section renders names as JSON
        // string literals ("cron_list"), so models often paste them back
        // verbatim with surrounding quotes. Strip a single layer of
        // matching `"…"` or `'…'` so `select:"foo"` and `select:foo`
        // resolve to the same tool. Without this the lookup would search
        // for a tool literally named `"foo"` (with quotes) and miss.
        const stripped = stripMatchingQuotes(raw.trim());
        if (!stripped) continue;
        const key = stripped.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (names.length >= maxResults) {
          truncated.push(stripped);
          continue;
        }
        names.push(stripped);
      }
      return this.loadAndReturnSchemas(names, truncated);
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
   * Candidates for keyword search: only deferred tools that have NOT yet
   * been revealed this session. Already-loaded (core) tools are in the
   * model's tool-declaration list already, so surfacing them here would
   * be noise. Already-revealed deferred tools were loaded via a prior
   * `select:` or keyword search and ARE in the declaration list too —
   * re-surfacing them in subsequent searches wastes tokens and risks
   * the model retrying a tool it already has.
   *
   * `select:<name>` mode is unrestricted — the model may legitimately
   * want to re-inspect the schema of a loaded tool — and handles its
   * own lookup via {@link loadAndReturnSchemas}.
   */
  private collectCandidates(): AnyDeclarativeTool[] {
    const registry = this.config.getToolRegistry();
    return registry
      .getAllTools()
      .filter(
        (t) =>
          t.shouldDefer &&
          !t.alwaysLoad &&
          !registry.isDeferredToolRevealed(t.name),
      );
  }

  private async loadAndReturnSchemas(
    names: string[],
    truncated: string[] = [],
  ): Promise<ToolResult> {
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

    // Track only the tools this call newly reveals so we can roll them
    // back if setTools() throws. Tools already revealed by an earlier
    // ToolSearch must stay revealed regardless of this call's outcome.
    const newlyRevealed: string[] = [];
    for (const requested of names) {
      const canonical = lowerIndex.get(requested.toLowerCase());
      if (!canonical) {
        missing.push(requested);
        continue;
      }
      // Treat ensureTool throws the same as a null return: log + report
      // missing. Without this, an exception mid-batch would propagate
      // out of the loop with previous tools already revealed but never
      // setTools()-synced — same orphaned-reveal failure mode the
      // setTools() catch block guards against.
      let tool: AnyDeclarativeTool | undefined;
      try {
        tool = await registry.ensureTool(canonical);
      } catch (err) {
        // Surface to stderr in production: debugLogger.warn is a no-op
        // unless DEBUG is set, so without a stderr write, factory
        // failures (network, missing module, etc.) would be invisible
        // to operators running headless and the agent would just see
        // a "missing" entry with no diagnosis. Use process.stderr.write
        // directly; the package-level eslint config bans console.* in
        // core src and there's no shared logger that surfaces in prod.
        debugLogger.warn(`ensureTool failed for ${canonical}:`, err);
        process.stderr.write(
          `[ToolSearch] ensureTool failed for "${canonical}": ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      if (!tool) {
        missing.push(requested);
        continue;
      }
      // Only reveal + count toward the setTools() trigger when the tool
      // is actually deferred. `select:` mode also accepts already-loaded
      // / alwaysLoad tools (the model may use it to re-inspect a schema)
      // — those don't need reveal (they're already in the declaration
      // list) and pulling them through setTools() would risk a spurious
      // "GeminiClient not initialised" failure for what is just a
      // schema-inspection call.
      const isLoadable = tool.shouldDefer && !tool.alwaysLoad;
      if (isLoadable) {
        const wasRevealed = registry.isDeferredToolRevealed(canonical);
        registry.revealDeferredTool(canonical);
        if (!wasRevealed) {
          newlyRevealed.push(canonical);
        }
      }
      loaded.push(tool);
    }

    // Re-sync the active chat's tool list ONLY when this call newly
    // revealed deferred tools (otherwise the declaration list is
    // already correct and setTools() is wasted work — and worse, a
    // null/uninitialised client would surface as a fake error for
    // what is just a schema-inspection request).
    let setToolsError: string | undefined;
    if (newlyRevealed.length > 0) {
      const geminiClient = this.config.getGeminiClient();
      if (!geminiClient) {
        // Optional chaining (`?.setTools()`) used to silently no-op here,
        // leaving the registry with reveals the API never received —
        // exactly the inconsistency `setTools() throws` already guards
        // against. Treat null client identically: rollback + surface an
        // error so the caller can retry once init is complete.
        setToolsError = 'GeminiClient not initialised';
      } else {
        try {
          await geminiClient.setTools();
        } catch (err) {
          setToolsError = err instanceof Error ? err.message : String(err);
          // Same rationale as ensureTool above: debugLogger.warn is
          // off in production, so a setTools() failure during reveal
          // would be invisible to operators. The error already lands
          // in the tool's ToolResult, but a stderr write helps when
          // someone is debugging from outside the agent transcript.
          debugLogger.warn(
            'setTools() failed while revealing deferred tools:',
            err,
          );
          process.stderr.write(
            `[ToolSearch] setTools() failed while revealing deferred tools: ${setToolsError}\n`,
          );
        }
      }

      if (setToolsError) {
        // Surface as a tool error so the agent knows the loaded tools
        // aren't actually available, instead of silently swallowing into
        // debugLogger.warn (which is off in production). Schemas are
        // withheld from llmContent (built below only when no error) so
        // the model doesn't think the tool is callable while the API
        // declaration list doesn't have it.
        //
        // Roll back this call's reveals so the registry stays consistent
        // with the API's declaration list. Without this, keyword search
        // would treat these tools as "already loaded" and exclude them
        // from candidates while the API still has no schema for them.
        for (const name of newlyRevealed) {
          registry.unrevealDeferredTool(name);
        }
      }
    }

    if (setToolsError) {
      return {
        llmContent: `Error: tools were located but could not be exposed to the API (setTools failed: ${setToolsError}). Retry the search next turn or call ToolSearch again with select:Name1,Name2 — re-running tool registration usually clears transient init races.`,
        returnDisplay: `setTools failed: ${setToolsError}`,
        error: {
          message: `setTools failed while revealing deferred tools: ${setToolsError}`,
        },
      };
    }

    // Escape `<` in the JSON-stringified schema so any `</function>`
    // (or `</functions>`) substring inside a tool's description / enum
    // / examples can't prematurely close the pseudo-XML wrapper. The
    // `<` JSON unicode escape decodes back to `<` when the model
    // interprets the JSON, but as raw text inside the wrapper it's no
    // longer the start of a closing tag.
    const schemaBlocks = loaded.map(
      (tool) =>
        `<function>${JSON.stringify(tool.schema).replace(/</g, '\\u003c')}</function>`,
    );
    let llmContent = '';
    if (schemaBlocks.length > 0) {
      llmContent += `<functions>\n${schemaBlocks.join('\n')}\n</functions>`;
    }
    if (missing.length > 0) {
      const header = llmContent ? '\n\n' : '';
      llmContent += `${header}Not found: ${missing.join(', ')}`;
    }
    if (truncated.length > 0) {
      // Surface the dropped names so the model knows it must re-issue
      // another ToolSearch for them — without this, the model would
      // assume every requested name was loaded and later receive an
      // "unknown tool" API error.
      const header = llmContent ? '\n\n' : '';
      llmContent += `${header}Truncated by max_results — request these in a follow-up call: ${truncated.join(', ')}`;
    }

    const displayParts: string[] = [];
    if (loaded.length > 0) displayParts.push(`Loaded ${loaded.length} tool(s)`);
    if (missing.length > 0) displayParts.push(`${missing.length} missing`);
    if (truncated.length > 0)
      displayParts.push(`${truncated.length} truncated`);
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
            // Reject empty queries at validation time so the model
            // doesn't waste a tool call to discover the runtime error
            // (`Error: query is empty`). The runtime guard stays as a
            // safety net for whitespace-only inputs that pass minLength.
            minLength: 1,
          },
          max_results: {
            type: 'integer',
            description: 'Maximum number of results to return (default: 5)',
            minimum: 1,
            maximum: HARD_MAX_RESULTS,
            default: DEFAULT_MAX_RESULTS,
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

/**
 * Strip a single layer of surrounding `"…"` or `'…'` if present.
 * Used to normalize `select:"foo"` → `foo` so models that paste tool
 * names back as JSON-quoted literals (the form they appear in the
 * deferred-tools section of the system prompt) resolve correctly.
 * Mismatched / unbalanced quotes are returned unchanged.
 */
function stripMatchingQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1);
  }
  return s;
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
