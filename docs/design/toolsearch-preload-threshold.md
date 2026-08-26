# ToolSearch preload threshold

## Problem

Deferred tools (`shouldDefer=true`) are unconditionally hidden behind
ToolSearch: every MCP tool (hardcoded in `DiscoveredMCPTool`) plus a set of
bundled built-ins (web_search, web_fetch, cron, monitor, worktree, …).
Deferral saves prompt tokens when the deferred set is large, but it is not
free: every mid-session reveal rewrites the function-declaration list, which
sits at the front of the tools→system→messages prefix, so a single ToolSearch
load invalidates the entire prompt KV cache. For a small deferred set the
deferral saves little and the cache damage plus the extra ToolSearch
round-trip make it a net loss.

Claude Code models this tradeoff with `ENABLE_TOOL_SEARCH=auto` / `auto:N`:
"tools load upfront if they fit within 10% of the context window, deferred
otherwise" (code.claude.com/docs/en/agent-sdk/tool-search). This change adds
the equivalent gate.

## Design

New setting `tools.toolSearch.threshold` (number, percent, default `10`).

At session start (`GeminiClient.startChat`, before the initial declarations are
built), when ToolSearch is registered and the threshold is > 0:

- Estimate the combined token footprint of every deferred tool schema —
  bundled built-ins and MCP alike
  (`JSON.stringify(tool.schema).length / CHARS_PER_TOKEN`).
- If the total fits within `threshold`% of the context window
  (`contentGeneratorConfig.contextWindowSize`, falling back to
  `tokenLimit(model)`), reveal them all via the existing
  `revealDeferredTool` mechanism. All-or-nothing — a partial reveal would
  leave an arbitrary subset behind ToolSearch, and any tool left deferred
  can still bust the cache on first use.
- Otherwise everything stays deferred (previous behavior). `threshold: 0`
  restores the old behavior unconditionally.

Preloaded tools therefore land in the initial declaration list, are filtered
out of the `tool_search` catalog (they are already directly callable), and the
declaration list stays stable for the whole session.

## Decisions

- **Session start only, never `setTools()`.** A mid-session reveal changes the
  declaration list and busts the very cache the preload exists to protect.
  Tools from servers that connect later stay deferred (advertised in the
  `tool_search` catalog, reachable through ToolSearch) until the next session
  start. `/clear` clears the revealed set and re-runs the decision.
- **One budget over the whole deferred set, bundled included.** Claude Code's
  auto threshold covers MCP/SDK tools only (its built-ins are managed
  separately), but it can afford that split: deferred tools are stripped from
  the prompt prefix before the cache key is computed, and a discovered tool's
  definition is expanded inline via a `tool_reference` block — "The prefix is
  untouched, so prompt caching is preserved"
  (platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
  Here every reveal — bundled or MCP — goes through `setTools()` and rewrites
  the declaration list. Excluding the ~14 bundled deferred tools (web_search,
  web_fetch, …) would leave the prefix one common tool-load away from a full
  cache bust, forfeiting exactly the stability the preload buys. When the
  union exceeds the budget everything stays deferred, which matches the
  pre-threshold baseline for bundled tools.
- **Threshold defaults to 10 (auto-mode on), unlike Claude Code's default.**
  Claude Code's unset default keeps MCP tools always deferred and makes
  `auto` opt-in — affordable there because a deferred tool's first use costs
  no cache invalidation. Here it costs a full prefix rebuild, so the
  auto-style gate is on by default; `threshold: 0` reproduces Claude Code's
  always-defer default.
- **Already-revealed tools count toward the budget** so repeated session
  starts (compression also passes through `startChat`) cannot ratchet the
  revealed set past the budget as servers come and go.
- **No preload when ToolSearch is unavailable** — the existing eager-reveal
  branch in `resolveDeferredToolsForCatalog` already exposes everything.
