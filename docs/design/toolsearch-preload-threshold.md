# ToolSearch preload threshold

> **Update:** The on-demand reveal and `setTools()` behavior described below is
> superseded by [Deferred Tool Call Bridge](deferred-tool-call-bridge.md).
> Session-start threshold preloading remains; tools that stay deferred are now
> reviewed through ToolSearch and invoked through ToolCall without changing the
> declaration list.
>
> **The default changed from `10` to `0`.** The cache argument below — every
> reveal rewrote the declaration list and so busted the whole prompt prefix —
> was the sole reason this gate shipped on by default. The bridge removes that
> premise: a reveal no longer touches the declaration list, so always-defer is
> affordable and this now matches Claude Code's default. What preloading still
> buys is the one `tool_search` round trip before a deferred tool's first use,
> which is a per-tool one-off rather than the whole-session compounding cost a
> cache bust was. Raise the threshold to opt back in.

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

New setting `tools.toolSearch.threshold` (number, percent, default `0` —
preload is opt-in; see the update note above).

At session start (`GeminiClient.startChat`, before the deferred-tools reminder
is resolved), when ToolSearch is registered and the threshold is > 0:

- Estimate the combined token footprint of every deferred tool schema —
  bundled built-ins and MCP alike
  (`JSON.stringify(tool.schema).length / CHARS_PER_TOKEN`).
- If the total fits within `threshold`% of the context window
  (`contentGeneratorConfig.contextWindowSize`, falling back to
  `tokenLimit(model)`), reveal them all via the existing
  `revealDeferredTool` mechanism. All-or-nothing — a partial reveal would
  leave an arbitrary subset behind ToolSearch, and any tool left deferred
  can still bust the cache on first use.
- Otherwise everything stays deferred — which, at the `0` default, is
  unconditionally.

Preloaded tools therefore land in the initial declaration list, are filtered
out of the startup deferred-tools reminder, and the declaration list stays
stable for the whole session.

## Decisions

- **Session start only, never `setTools()`.** Revealing a tool the startup
  reminder already announced would make `queueAddedMcpToolsReminder` flag it
  as "removed", and a mid-session declaration change busts the very cache the
  preload exists to protect. Tools from servers that connect later stay
  deferred (announced via the added-tools reminder, reachable through
  ToolSearch) until the next session start. `/clear` clears the revealed set
  and re-runs the decision.
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
- **Threshold defaults to 0 (always-defer), matching Claude Code's default.**
  This shipped as `10` — auto-mode on — because a reveal then cost a full
  prefix rebuild, which Claude Code's `tool_reference` expansion does not.
  The bridge removed that asymmetry, so the default now matches Claude Code's
  always-defer and `threshold: N` is the opt-in. The gate itself is unchanged:
  it still runs only at session start, still covers bundled and MCP deferred
  tools alike, and is still all-or-nothing.
- **Already-revealed tools count toward the budget** so repeated session
  starts (compression also passes through `startChat`) cannot ratchet the
  revealed set past the budget as servers come and go.
- **No preload when ToolSearch is unavailable** — the existing eager-reveal
  branch in `resolveDeferredToolsForReminder` already exposes everything.
