# Resident Context Cost

Every request a session sends carries the same prefix before any of your conversation: the system prompt, the schema of every declared tool, your context (`QWEN.md`) files, and the skill listing. You pay for that prefix on **every turn**, including the turns that just answer a question. This page is about measuring it and cutting it.

[Token caching](token-caching.md) reduces the _price_ of the prefix. This page reduces the _prefix_. They compose — a smaller prefix is cheaper cached too.

## See what you are paying for

```
/context detail
```

`/context` prints the breakdown by category; `detail` adds per-item rows — each built-in tool, each MCP tool, each context file, each listed skill — so you can see which single entry is the expensive one. Read it on the **first turn** of a session, where the conversation is still empty and everything you see is prefix.

The categories are what `/context` reports plus two bookkeeping rows: `startupContext` (the environment block sent as the first user turn) and an explicit residual for whatever the categories do not attribute, so the parts always add up to the total.

## Use idle cost, not percent of window

A percentage of the context window is not a target you can hold, because the denominator is arbitrary. The same configuration reads as 6.5% on a 1M-context model and 37% on a 128k one — identical text, identical cost, wildly different number. Use instead:

> **Idle cost** — the input tokens of a session that asks one question and calls no tool.

It is independent of the model and the window, and you cannot make it look better by moving text from a tool schema into a context file. A second useful reading is **how many turns it takes for the conversation to outgrow the prefix**: a prefix that takes 20 turns to amortise is never amortised in a 5-turn session.

## The levers, in order of return

### 1. Turn off features you do not use

Each feature that registers a tool pays for that tool's schema on every request. The largest single built-in entries are the ones belonging to optional features, so a deployment that does not use workflows, goals, scheduled tasks, or the review tooling saves more by switching those features off than by any amount of prompt editing. This also removes the tool from subagents, which the next lever does not always do.

### 2. Keep the eager tool surface to what you actually use

`tools.eager` is an allowlist of built-in tools whose schemas stay in the initial request. Everything else becomes **deferred**: still registered, still listed in `/tools`, still callable — the model reaches it through the `tool_search` → `tool_call` bridge when it turns out to need it.

Measure the allowlist against the right baseline. Tools that are on demand by _their own_ default are already absent from the first request, and since `tools.toolSearch.threshold` began defaulting to `0` nothing preloads them back, so an allowlist's saving is only the schemas of the eager-by-default tools it withholds — not the whole built-in surface. Take a fresh `/context` reading on the version you actually run before attributing a number to your list.

```jsonc
{
  "tools": {
    "eager": [
      "read_file",
      "write_file",
      "edit",
      "glob",
      "grep_search",
      "run_shell_command",
      "skill",
    ],
  },
}
```

Four things to know before you use it:

- **It is not a disable.** A demoted tool stays reachable. If you meant to remove a tool, use a whole-tool `permissions.deny` rule or `tools.disabled`.
- **Some tools are exempt** and keep their normal loading behaviour whatever the list says: `tool_search` and `tool_call` (the two halves of the bridge that reaches a withheld tool), `structured_output`, the plan-mode lifecycle tools (`enter_plan_mode`, `exit_plan_mode`, `ask_user_question`), `task_stop`, MCP tools (`mcp__*`), and Computer Use tools (`computer_use__*`). `task_stop` and the Computer Use family are on demand by default anyway, so gating them would save nothing; MCP tools are governed by `tools.toolSearch.*` and the per-server `includeTools` / `excludeTools` filters; and nothing in `tools.eager` can drop one of the rest: that takes a whole-tool `permissions.deny` rule, a `tools.disabled` entry, or `--exclude-tools` — and for the bridge pair, `tools.toolSearch.enabled: false` removes both halves at once. Removing a bridge half is not a neutral way out of the allowlist: every ordinary deferred tool (all MCP tools, the deferred Computer Use family) is then force-declared into every request, while a withheld tool is not offered to the model and cannot be loaded back through the bridge — it stays registered, so a direct call by name still goes through normal approval.
- **`permissions.allow` saves nothing.** It is pure auto-approval: it never demotes, hides, or removes a tool. Neither do approval modes.
- **It needs both halves of the bridge.** A withheld tool is reviewed with `tool_search` and invoked through `tool_call`; `tool_search` alone can read a schema it cannot call. If either is unregistered — `tools.toolSearch.enabled: false` denies both; a `tool_search`/`tool_call` deny rule, an `--exclude-tools` entry, or a `tools.disabled` entry removes one — the allowlist still withholds the schemas, nothing can load them back, and the demoted tools are not offered to the model for that session (a warning is logged); they stay registered, so a direct call by name still goes through normal approval. Ordinary deferred tools fall back to being declared eagerly in that case; tools you demoted with `tools.eager` do not.

`tools.visible` is the escape hatch for one tool you want declared up front even though it is deferred by default.

### 3. Move scenario guidance out of context files into skills

A context file is concatenated into every request of every session it applies to, with no relevance gating. A [skill](skills.md) is listed by its name and description only — in one measured sample, 84 skills averaged about 55 tokens each — and loads its body when invoked, and a skill [gated on `paths:`](skills.md#optional-gate-a-skill-on-file-paths-paths) is not even listed until a matching file is touched.

Keep in a context file only what is always true — identity, vocabulary, a hard constraint — and put "when doing X, do Y" in a skill or a [`paths:`-gated rule](rules.md). `/context detail` names each context file, and for an [extension's](../extension/getting-started-extensions.md) file it names the extension that owns it.

### 4. The system prompt, last

The base prompt is already the smallest of the resident categories, and roughly a third of it is safety and permission text that must not be edited. It also now describes only the tools the session actually declared, so trimming your tool surface shrinks it a little for free. Replacing it wholesale with `--system-prompt` is possible and is the highest-risk change on this page; if you do, diff the upstream prompt on every upgrade.

## Traps

- **Subagents get the deferred tools too.** A subagent that does not declare an explicit tool list receives every registered tool's schema, deferred ones included, and does not go through ToolSearch. `tools.eager` and `permissions.deny` are the only knobs that reach it; the preload threshold does not.
- **The background memory agent needs six tools** (`read_file`, `grep_search`, `glob`, `run_shell_command`, `write_file`, `edit`). Denying one degrades it silently rather than erroring.
- **Tokens can move rather than disappear.** Take away `grep_search` and `glob` and the model may reach for `grep` and `find` through the shell, whose output lands in the conversation. New output adds input tokens when first sent; unchanged history containing it may hit the provider's prefix cache on later requests. Judge a change by total input tokens per task, provider-reported cached and uncached input, and the actual bill, not by the prefix alone.
- **Resumed sessions re-send what they need.** A demoted tool that appears in a resumed session's history gets its schema back automatically; a denied tool does not.
- **Reaching a withheld tool no longer rewrites the prefix — but it used to, and old advice assumes it does.** Discovery goes through the `tool_search` → `tool_call` bridge, which leaves the declared tool list byte-stable, so the prompt-cache prefix survives a mid-session discovery; the cost is one extra round trip before a withheld tool's first use. That is why `tools.toolSearch.threshold` now defaults to `0`: carrying the deferred set every turn is no longer the cheaper side of the trade. Raise the threshold only to buy back that round trip for _ordinary_ deferred tools (MCP tools and the on-demand built-ins) in a session that will certainly need them — it never preloads a tool you demoted with `tools.eager`; those stay behind the bridge at any threshold.
- **Prefix-caching models used to invert this trade; for deferral they no longer do.** For a model whose discount depends on an unchanged prefix, keeping the declaration list identical once mattered more than keeping it small — which is why some deployments disabled ToolSearch by hand. Reaching a withheld tool now leaves that list byte-stable, so that particular reason has expired — with one exception, stated in the `tool_search` description itself: a tool-set refresh may still re-declare a withheld tool when the live history contains a direct call to it, and that does move the prefix. Prefix stability still argues against anything else that rewrites the prefix mid-session, such as editing a context file between turns.
- **Scope leaks.** Settings apply to every client that reads them (CLI, Web Shell, serve), so a per-deployment tool surface needs its own settings scope.

## Verify the saving

1. Note idle cost before the change: a fresh session, one trivial question, `/context` on the first turn.
2. Apply one lever at a time and repeat, restarting the session — most of these settings are read at startup.
3. Confirm that capability survived, on your own task set: tool-call success rate, how often `tool_search` has to be called, and task outcomes. A demoted tool that the model never thinks to look for does not fail loudly; it just stops being used.
4. Check the bill, not only the prefix — see the trap about tokens moving into the conversation.

## See also

- [Token Caching](token-caching.md) — what caching does to the price of what remains.
- [Rules](rules.md) — `paths:`-conditional context, including what an extension may contribute.
- [Skills](skills.md) — progressive disclosure, and `paths:` gating.
- [Settings reference](../configuration/settings.md) — the exact semantics of `tools.eager`, `tools.visible`, `tools.disabled`, `tools.toolSearch.*`, `permissions.deny`.
