# qwen-code — feature gaps vs Claude Code

_Snapshot: 2026-07-27. Scope: the **core agent** (`packages/core`, `packages/cli`), not the `rc-gateway` remote-control layer. Findings from a static grep/read inventory of the fork (see `scratchpad/qwen-inventory-{A,B}.md` for the full evidence)._

## TL;DR

qwen-code is at **near-parity with Claude Code** and a **superset in places**. It has independently re-implemented essentially the entire CC extensibility surface. The genuine gaps are small and specific — **two real capability gaps** (web search, output styles) and two minor conveniences.

---

## The gaps

| #   | Gap                             | Status                | Value    | Scope                            | Rough effort                    |
| --- | ------------------------------- | --------------------- | -------- | -------------------------------- | ------------------------------- |
| 1   | **Web search**                  | Absent                | **High** | `packages/core` (new tool)       | ~1–2 days (+ provider decision) |
| 2   | **Output styles**               | Absent                | Medium   | `packages/core` + `packages/cli` | ~1–2 days                       |
| 3   | Runtime reasoning-effort toggle | Partial (config-only) | Low      | `packages/cli` (command)         | ~0.5 day                        |
| 4   | Dedicated commit-message helper | Partial               | Low      | `packages/cli` (command/skill)   | ~0.5–1 day                      |

### 1. Web search — **Absent** (highest-value, self-contained)

- **Evidence:** no `WebSearch`/web-search tool class exists; qwen-code's own Claude-config importer maps it to nothing — `packages/core/src/tools/claude-converter.ts:97` → `WebSearch: 'None'`. Web **fetch** (a known URL) exists (`packages/core/src/tools/web-fetch.ts`), but open-web **search** does not.
- **Why it matters:** it's the one materially-missing _capability_ (not a UI nicety) — the agent can read a URL you give it but cannot find one.
- **Shape:** a new tool in `packages/core/src/tools/web-search.ts`, parallel to `web-fetch.ts`, registered alongside the other tools.
- **Open decision (blocks spec):** which search backend. Options include a search-API provider (Brave/Tavily/SerpAPI/Bing — needs an API key + config), or — since this is a Gemini-lineage fork — re-exposing **Gemini's built-in Google Search grounding** where the model/provider supports it. This choice drives the whole design and should be settled in brainstorming.

### 2. Output styles — **Absent**

- **Evidence:** qwen-code's own converter comment — "Output styles are not yet supported" (`packages/core/src/tools/claude-converter.ts`).
- **Why it matters:** CC's output styles let a user switch the agent's response persona/format (e.g. concise, explanatory, a custom style) without editing the system prompt by hand. qwen-code has themes and a customizable memory file but no first-class switchable output-style mechanism.
- **Shape:** a persona/system-prompt-overlay layer + an `/output-style` command + a settings key; likely a small style-registry (built-in + user-defined markdown styles) injected into the system prompt.

### 3. Runtime reasoning-effort toggle — **Partial**

- **Evidence:** `reasoning.effort` / `thinkingConfig` is wired at the **config** level across providers (incl. Anthropic adaptive-thinking detection), but there's no interactive slash command to change it mid-session.
- **Gap vs CC:** CC lets you dial thinking up/down interactively. qwen-code requires a config/restart.
- **Shape:** a `/think` (or `/reasoning`) command that mutates the already-existing reasoning config for the live session.

### 4. Dedicated commit-message helper — **Partial**

- **Evidence:** has `/review` (PR review, inline GitHub comments, isolated worktree) and `/setup-github` (CI workflows), but no CC-style "generate this commit's message from the staged diff" flow.
- **Shape:** a `/commit` command or a small skill that reads the staged diff and drafts a message (and optionally commits).

---

## Not gaps — already at parity (do **not** rebuild)

Verified PRESENT in the core agent: **hooks** (identical event names — `PreToolUse`/`PostToolUse`/`SessionStart`/`Stop`/`SubagentStop`…), **MCP** (official SDK: stdio/SSE/HTTP + OAuth), **subagents** (`AgentTool` + built-in `general-purpose`/`Explore` types + custom `.md` agents), **skills** (`SKILL.md`), **plan mode**, **5-tier approval modes** (plan/default/auto-edit/auto/yolo) + a `permissions.allow/deny` engine + folder-trust, **sandboxing** (macOS Seatbelt + Docker/Podman), **memory files** (`QWEN.md`/`AGENTS.md`, hierarchical + imports), **54 built-in + custom slash commands**, **checkpoint/rewind** (`/rewind` + `/restore` via a shadow git repo), **session resume** (`--resume`/`--continue`/`--fork-session`), **VS Code + Zed IDE** integrations, **statusline**, **themes / vim mode / keybindings**, **auto-compact**, **@-file mentions**, **model switching** (`/model`), **image paste** (multimodal input), **background shell**, **web fetch**.

## Superset — qwen-code has tools CC's built-in set does not

`cron`, `lsp`, `monitor`, `worktree`, `workflow`, `tool_search`, `computer_use`.

---

## Remote-control featureset status (context for prioritization)

The `rc-gateway` remote-control sub-project is **feature-complete and hardened** — all 24 of its OpenSpec changes are implemented, the security audit (findings A–J) is fully remediated, and `GET /rc/peers` is built (PR #13). Nothing on the remote-control side blocks moving to the gaps above. Remaining rc items are **not feature work**: merge PR #13, post-deploy `openspec archive` housekeeping, and out-of-scope daemon-side / native-app / web-client work.

**Note on scope:** every gap above lives in `packages/core` / `packages/cli` — the areas that were **off-limits** ("no daemon/core changes") throughout the remote-control work. Building any of them steps outside that boundary. That's fine in principle (qwen-code does heavy core work), but it's a different kind of change than the isolated `rc-gateway` sub-project and should be an explicit decision.

## Suggested order

1. **Web search** — highest value, self-contained, the only true capability gap. Needs a backend decision first (brainstorm).
2. **Output styles** — medium value, self-contained.
3. **Reasoning toggle** / **commit helper** — low-effort conveniences; batch or skip.
