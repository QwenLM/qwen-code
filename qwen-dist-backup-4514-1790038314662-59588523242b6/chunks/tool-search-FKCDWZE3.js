// Force strict mode and setup for ESM
"use strict";
import {
  escapeJsonTagCharacters
} from "./chunk-CHEIIBT3.js";
import {
  getLeaderOnlyToolUnavailableMessage,
  getSubagentPlanToolUnavailableMessage,
  isLeaderOnlyToolUnavailableInSubagent,
  isPlanLifecycleToolUnavailableInSubagent
} from "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import {
  isMediaPolicyToolHiddenFromModel
} from "./chunk-MNU36NGH.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import {
  DiscoveredMCPTool
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/tool-search.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("TOOL_SEARCH");
var DEFAULT_MAX_RESULTS = 5;
var HARD_MAX_RESULTS = 20;
var SCORE_NAME_EXACT_BUILTIN = 10;
var SCORE_NAME_SUBSTR_BUILTIN = 5;
var SCORE_HINT_BUILTIN = 4;
var SCORE_DESC_BUILTIN = 2;
var SCORE_NAME_EXACT_MCP = 12;
var SCORE_NAME_SUBSTR_MCP = 6;
var SCORE_ACTION_ALIAS_BUILTIN = 6;
var TOOL_SEARCH_STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "should",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "what",
  "which",
  "with",
  "would",
  "you"
]);
var ACTION_TERM_ALIASES = /* @__PURE__ */ new Map([
  ["cancel", ["cancel", "delete", "remove", "stop", "clear"]],
  ["clear", ["clear", "delete", "remove", "cancel", "stop"]],
  ["delete", ["delete", "remove", "cancel", "stop", "clear"]],
  ["remove", ["remove", "delete", "cancel", "stop", "clear"]],
  ["stop", ["stop", "cancel", "delete", "remove", "clear"]]
]);
var toolSearchDescription = `Fetches function declarations for deferred tools and registers them with the active session so subsequent turns can call them.

Deferred tools appear by name in the deferred-tools startup reminder. Until fetched, only the name is known \u2014 there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' function declarations (name + description + parameter schema) inside a <functions> block.

The returned <functions> block is informational \u2014 it shows what the schema looks like. Calling the tool itself happens via the model's normal function-call mechanism on the NEXT turn, after the active session's declaration list has been updated. Tools fetched here remain available for the rest of the session.

Query forms:
- "select:ToolA,ToolB" \u2014 fetch these exact tools by name
- "keyword phrase" \u2014 keyword search, up to max_results best matches
- "+must-word other" \u2014 require "must-word" in the name, rank remaining terms
`;
var ToolSearchInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "ToolSearchInvocation");
  }
  getDescription() {
    return this.params.query;
  }
  async execute(_signal) {
    const query = (this.params.query ?? "").trim();
    if (!query) {
      return {
        llmContent: "Error: query is empty. Use `select:ToolName` or free-text keywords.",
        returnDisplay: "Empty query",
        error: { message: "Empty query" }
      };
    }
    const maxResults = clamp(
      this.params.max_results ?? DEFAULT_MAX_RESULTS,
      1,
      HARD_MAX_RESULTS
    );
    if (query.toLowerCase().startsWith("select:")) {
      const seen = /* @__PURE__ */ new Set();
      const names = [];
      const truncated = [];
      for (const raw of query.slice("select:".length).split(",")) {
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
    const terms = tokenize(query);
    const requiredTerms = terms.filter((t) => t.startsWith("+")).map((t) => t.slice(1)).filter((t) => t.length > 0);
    const searchTerms = terms.map((t) => t.startsWith("+") ? t.slice(1) : t).filter((t) => t.length > 0);
    if (searchTerms.length === 0) {
      return {
        llmContent: "Error: no search terms extracted from query. Use `select:ToolName` or include keywords.",
        returnDisplay: "No search terms",
        error: { message: "No search terms" }
      };
    }
    const candidates = this.collectCandidates();
    const scored = [];
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
        returnDisplay: `No matches for '${query}'`
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
  collectCandidates() {
    const registry = this.config.getToolRegistry();
    return registry.getAllTools().filter(
      (t) => registry.isDeferredAndHidden(t.name) && // Media-policy tools without modelAccess.enabled must never be
      // surfaced to the model — not even via keyword discovery.
      !isMediaPolicyToolHiddenFromModel(this.config, t)
    );
  }
  async loadAndReturnSchemas(names, truncated = []) {
    if (names.length === 0) {
      return {
        llmContent: "Error: no tool names provided.",
        returnDisplay: "No tool names",
        error: { message: "No tool names" }
      };
    }
    const registry = this.config.getToolRegistry();
    const loaded = [];
    const missing = [];
    const blocked = [];
    const lowerIndex = /* @__PURE__ */ new Map();
    for (const realName of registry.getAllToolNames()) {
      lowerIndex.set(realName.toLowerCase(), realName);
    }
    const newlyRevealed = [];
    for (const requested of names) {
      const canonical = lowerIndex.get(requested.toLowerCase());
      if (!canonical) {
        missing.push(requested);
        continue;
      }
      if (!registry.isToolDeclared(canonical)) {
        const tool2 = registry.getTool(canonical);
        if (tool2 && isMediaPolicyToolHiddenFromModel(this.config, tool2)) {
          blocked.push(canonical);
        } else {
          missing.push(requested);
        }
        continue;
      }
      if (isPlanLifecycleToolUnavailableInSubagent(canonical) || isLeaderOnlyToolUnavailableInSubagent(canonical)) {
        blocked.push(canonical);
        continue;
      }
      let tool;
      try {
        tool = await registry.ensureTool(canonical);
      } catch (err) {
        debugLogger.warn(`ensureTool failed for ${canonical}:`, err);
        process.stderr.write(
          `[ToolSearch] ensureTool failed for "${canonical}": ${err instanceof Error ? err.message : String(err)}
`
        );
      }
      if (!tool) {
        missing.push(requested);
        continue;
      }
      if (isMediaPolicyToolHiddenFromModel(this.config, tool)) {
        blocked.push(canonical);
        continue;
      }
      const isLoadable = registry.isDeferredAndHidden(canonical);
      if (isLoadable) {
        const wasRevealed = registry.isDeferredToolRevealed(canonical);
        registry.revealDeferredTool(canonical);
        if (!wasRevealed) {
          newlyRevealed.push(canonical);
        }
      }
      loaded.push(tool);
    }
    let setToolsError;
    if (newlyRevealed.length > 0) {
      const llmClient = this.config.getLlmClient();
      if (!llmClient) {
        setToolsError = "LlmClient not initialised";
      } else {
        try {
          await llmClient.setTools();
        } catch (err) {
          setToolsError = err instanceof Error ? err.message : String(err);
          debugLogger.warn(
            "setTools() failed while revealing deferred tools:",
            err
          );
          process.stderr.write(
            `[ToolSearch] setTools() failed while revealing deferred tools: ${setToolsError}
`
          );
        }
      }
      if (setToolsError) {
        for (const name of newlyRevealed) {
          registry.unrevealDeferredTool(name);
        }
      }
    }
    if (setToolsError) {
      return {
        llmContent: `Error: tools were located but could not be exposed to the API (setTools failed: ${setToolsError}). Retry the search next turn or call ToolSearch again with select:Name1,Name2 \u2014 re-running tool registration usually clears transient init races.`,
        returnDisplay: `setTools failed: ${setToolsError}`,
        error: {
          message: `setTools failed while revealing deferred tools: ${setToolsError}`
        }
      };
    }
    const schemaBlocks = loaded.map(
      (tool) => `<function>${escapeJsonTagCharacters(JSON.stringify(tool.schema))}</function>`
    );
    let llmContent = "";
    if (schemaBlocks.length > 0) {
      llmContent += `<functions>
${schemaBlocks.join("\n")}
</functions>`;
    }
    if (missing.length > 0) {
      const header = llmContent ? "\n\n" : "";
      llmContent += `${header}Not found: ${missing.join(", ")}`;
    }
    let blockedErrorMessage;
    if (blocked.length > 0) {
      const blockedMessages = blocked.map(
        (name) => isLeaderOnlyToolUnavailableInSubagent(name) ? getLeaderOnlyToolUnavailableMessage(name) : isPlanLifecycleToolUnavailableInSubagent(name) ? getSubagentPlanToolUnavailableMessage(name) : `Tool "${name}" is a media policy tool and is not available to the model.`
      );
      blockedErrorMessage = blockedMessages.join("\n");
      const header = llmContent ? "\n\n" : "";
      llmContent += `${header}Unavailable: ${blockedErrorMessage}`;
    }
    if (truncated.length > 0) {
      const header = llmContent ? "\n\n" : "";
      llmContent += `${header}Truncated by max_results \u2014 request these in a follow-up call: ${truncated.join(", ")}`;
    }
    const displayParts = [];
    if (loaded.length > 0) displayParts.push(`Loaded ${loaded.length} tool(s)`);
    if (missing.length > 0) displayParts.push(`${missing.length} missing`);
    if (blocked.length > 0) displayParts.push(`${blocked.length} unavailable`);
    if (truncated.length > 0)
      displayParts.push(`${truncated.length} truncated`);
    const returnDisplay = displayParts.join(", ") || "No tools loaded";
    const result = { llmContent, returnDisplay };
    if (blockedErrorMessage && loaded.length === 0) {
      result.error = { message: blockedErrorMessage };
    }
    return result;
  }
};
var ToolSearchTool = class _ToolSearchTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _ToolSearchTool.Name,
      ToolDisplayNames.TOOL_SEARCH,
      toolSearchDescription,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
            // Reject empty queries at validation time so the model
            // doesn't waste a tool call to discover the runtime error
            // (`Error: query is empty`). The runtime guard stays as a
            // safety net for whitespace-only inputs that pass minLength.
            minLength: 1
          },
          max_results: {
            type: "integer",
            description: "Maximum number of results to return (default: 5)",
            minimum: 1,
            maximum: HARD_MAX_RESULTS,
            default: DEFAULT_MAX_RESULTS
          }
        },
        required: ["query"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      false,
      // shouldDefer — this tool itself must always be visible
      true,
      // alwaysLoad — core discovery tool, never hidden
      "tool search discover find schema"
    );
    this.config = config;
  }
  static {
    __name(this, "ToolSearchTool");
  }
  static Name = ToolNames.TOOL_SEARCH;
  createInvocation(params) {
    return new ToolSearchInvocation(this.config, params);
  }
};
function tokenize(query) {
  return query.toLowerCase().split(/\s+/g).map(normalizeSearchTerm).filter((t) => t !== null);
}
__name(tokenize, "tokenize");
function normalizeSearchTerm(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const required = trimmed.startsWith("+");
  const body = required ? trimmed.slice(1) : trimmed;
  const normalized = body.replace(
    /^[^\p{L}\p{N}_.+#-]+|[^\p{L}\p{N}_.+#-]+$/gu,
    ""
  );
  if (normalized.length < 2 || TOOL_SEARCH_STOP_WORDS.has(normalized)) {
    return null;
  }
  return required ? `+${normalized}` : normalized;
}
__name(normalizeSearchTerm, "normalizeSearchTerm");
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
__name(clamp, "clamp");
function stripMatchingQuotes(s) {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if (first === '"' && last === '"' || first === "'" && last === "'") {
    return s.slice(1, -1);
  }
  return s;
}
__name(stripMatchingQuotes, "stripMatchingQuotes");
function candidateMatchesRequired(tool, requiredTerms) {
  if (requiredTerms.length === 0) return true;
  const nameLower = tool.name.toLowerCase();
  return requiredTerms.every(
    (t) => getSearchTermVariants(t).some((variant) => nameLower.includes(variant))
  );
}
__name(candidateMatchesRequired, "candidateMatchesRequired");
function scoreTool(tool, terms) {
  const isMcp = tool instanceof DiscoveredMCPTool;
  const nameLower = tool.name.toLowerCase();
  const descLower = (tool.description ?? "").toLowerCase();
  const hintLower = (tool.searchHint ?? "").toLowerCase();
  const hintParts = hintLower ? hintLower.split(/\s+/g).filter(Boolean) : [];
  let total = 0;
  for (const term of terms) {
    if (term.length === 0) continue;
    const variants = getSearchTermVariants(term);
    let nameScore = 0;
    for (const variant of variants) {
      if (nameLower === variant || nameLower.endsWith("_" + variant) || nameLower.endsWith("." + variant)) {
        nameScore = Math.max(
          nameScore,
          isMcp ? SCORE_NAME_EXACT_MCP : SCORE_NAME_EXACT_BUILTIN
        );
      } else if (nameLower.includes(variant)) {
        nameScore = Math.max(
          nameScore,
          isMcp ? SCORE_NAME_SUBSTR_MCP : SCORE_NAME_SUBSTR_BUILTIN
        );
      }
    }
    total += nameScore;
    if (hintParts.some((p) => variants.includes(p))) {
      total += SCORE_HINT_BUILTIN;
    }
    if (variants.some((variant) => descLower.includes(variant))) {
      total += SCORE_DESC_BUILTIN;
    }
    if (ACTION_TERM_ALIASES.has(term) && variants.filter((variant) => variant !== term).some(
      (variant) => nameLower.includes(variant) || hintParts.some((p) => p === variant)
    )) {
      total += SCORE_ACTION_ALIAS_BUILTIN;
    }
  }
  return total;
}
__name(scoreTool, "scoreTool");
function getSearchTermVariants(term) {
  return ACTION_TERM_ALIASES.get(term) ?? [term];
}
__name(getSearchTermVariants, "getSearchTermVariants");
export {
  ToolSearchTool,
  scoreTool,
  tokenize
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
