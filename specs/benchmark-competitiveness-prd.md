# PRD: Benchmark Competitiveness — Close the Terminal-Bench-2 Performance Gap

## Situation

We ran proto against [terminal-bench-2](https://github.com/alexgshaw/terminal-bench) (89 tasks spanning software engineering, ML, security, sysadmin, and data science) using minimax-m2.7 via our LiteLLM gateway.

Current terminal-bench-2 leaderboard (top entries using models we have access to):

| Score | Agent     | Model           |
| ----- | --------- | --------------- |
| 81.8% | ForgeCode | GPT-5.4         |
| 80.2% | ForgeCode | Claude Opus 4.6 |
| 78.4% | SageAgent | GPT-5.3-Codex   |
| 75.3% | Capy      | Claude Opus 4.6 |

We did a deep source-code analysis of [ForgeCode](https://github.com/antinomyhq/forge) (5.7k stars, Rust, actively maintained) and identified the precise design decisions behind the ~5% gap between ForgeCode and simpler agents using the same model. This PRD captures what we found and what proto needs to implement.

**Target:** Match or exceed ForgeCode's 80.2% on terminal-bench-2 with Claude Opus 4.6.

---

## Problem

Proto already has many competitive features: compaction with AI summarization, doom loop detection, todo tools, LSP, truncation, apply_patch. The remaining gaps are specific and fixable.

### P0 — Doom Loop Blocks in Non-Interactive Mode

**Root cause:** `permission/next.ts:143-156` — when doom_loop fires, it creates a `new Promise((resolve, reject) => { s.pending[id] = { resolve, reject }; Bus.publish(Event.Asked, info) })`. In interactive mode, the TUI surfaces a dialog and the user resolves it. In `--yolo` mode with no TTY (e.g., terminal-bench eval containers), nothing resolves the promise — the agent **hangs until timeout**.

This is likely responsible for a significant portion of our timeout failures. The `make-mips-interpreter` task timed out in our first run; doom loop blocking is a likely cause.

**Expected behavior in `--yolo` mode:** When doom loop fires, auto-inject the warning message into the conversation and immediately continue — do not wait for user permission. The goal is to break the loop, not halt execution.

### P1 — Tool Error Reflection is Missing

When a tool call fails, proto retries silently. ForgeCode injects a forced reflection prompt:

> _"Pinpoint exactly what was wrong with the tool call. Explain why that mistake happened. Now make the correct tool call."_

This forces diagnosis before retry. On terminal-bench tasks where wrong approaches to security challenges or system configurations need fundamentally different strategies, blind retry wastes tokens and leads to context exhaustion.

### P2 — Codesearch Fails Silently in Eval Environments

`tool/codesearch.ts` calls `https://mcp.exa.ai` — an external API. In Docker eval containers without outbound internet (or with network isolation), this call fails silently. The model gets no error, no fallback, and no useful output. The tool should detect network failure, return a clear error, and fall back to local ripgrep.

### P3 — No External File Change Detection

When bash commands modify files previously read into context, the model makes decisions based on stale content. ForgeCode tracks SHA-256 hashes of every file it reads and injects a notification before each turn:

```xml
<information>
  <critical>The following files have been modified externally. Re-read them if relevant.</critical>
  <files><file>src/config.rs</file></files>
</information>
```

Terminal-bench tasks frequently involve build systems, config files, and generated code that changes as a side-effect of shell commands.

### P4 — Compaction Summary Doesn't Preserve Todo State

Proto's compaction does AI summarization (good!) but the summary prompt doesn't explicitly instruct the model to preserve the current todo list state. After compaction, the agent sometimes re-plans work it already completed.

ForgeCode's compaction template explicitly preserves:

- Task plan: added / in_progress / done / cancelled items
- File operations: paths only (no content)
- Shell commands: command text only (no output)

The structured format guarantees todo state survives compaction.

### P5 — No Workspace Tech Stack Discovery at Startup

ForgeCode injects file extension statistics from `git ls-files` into every system prompt:

```
Workspace: 47 .ts files, 12 .py files, 3 .c files, 1 Makefile
```

This gives the model immediate tech stack awareness without requiring an exploration step. Proto currently starts cold — the model discovers the workspace structure through tool calls, consuming tokens that could go toward the actual task.

---

## Approach

### 1. Fix Doom Loop in Non-Interactive / Yolo Mode (P0)

In `session/processor.ts` and `permission/next.ts`, when `--yolo` is active and a `doom_loop` permission request fires:

- Do NOT create a blocking promise
- Inject the doom loop warning directly into the conversation as a system/user message
- Continue execution immediately

Suggested injected message:

> _"You appear to be stuck in a repetitive loop. Stop retrying the same approach. Try a different tool, different arguments, or a fundamentally different strategy to accomplish the goal."_

Detection threshold (configurable): 3 consecutive identical tool+argument combos, or a repeating A→B→C→A pattern. These thresholds are already implemented in the detector — this change only affects the resolution path.

### 2. Add Tool Error Reflection Hook (P1)

After `N` consecutive tool failures in a single turn (suggested default: 3), inject a reflection message before the next model call:

```
Tool call failed (attempt {{n}} of {{max}}).
Before retrying: (1) identify exactly what went wrong, (2) explain why it happened,
(3) describe your corrected approach. Do not blindly retry the same call.
```

Configurable via `opencode.json`:

```json
{
  "agent": {
    "maxToolFailuresPerTurn": 3
  }
}
```

### 3. Codesearch Graceful Fallback (P2)

In `tool/codesearch.ts`:

- Wrap the Exa API call with a 5s timeout
- On network failure or timeout, return a clear error message to the model (not silent failure)
- Add a fallback path using ripgrep with the query terms as patterns, returning top matches with context
- Make fallback behavior configurable (`codesearch.fallback: "ripgrep" | "none"`)

### 4. External File Change Detection (P3)

New module: `session/file-tracker.ts`

- On every `ReadTool` call, record `{ path, mtime, contentHash }` in session state
- Before each model turn, check all tracked files for external modification (mtime change + hash diff)
- If changes detected, prepend an `<information>` block to the next user message listing modified paths
- Bound the tracked set: evict entries for files not accessed in the last 10 turns
- Config: `session.fileTracking: boolean` (default `true`)

### 5. Compaction Summary: Preserve Todo State (P4)

Update the compaction agent's system prompt to explicitly require structured preservation:

```
Your summary MUST include all of the following sections:

## Current Todo List
List every todo item with its exact status: added | in_progress | completed | cancelled

## Files Modified
List paths of all files created or edited (paths only, no content)

## Files Read
List paths of all files read (paths only, no content — deduplicate, keep only the most recent read per path)

## Commands Executed
List shell commands run (commands only, no output)

## Current State
One paragraph describing what has been accomplished and what remains.
```

This ensures the agent can resume correctly after compaction without re-planning completed work.

### 6. Workspace Stats in System Prompt (P5)

In `session/system.ts` `environment()`, add workspace file extension stats:

```typescript
// Only in git repos
const files = await $`git ls-files`.text()
const extensions = countExtensions(files) // { ".ts": 47, ".py": 12, ".c": 3 }
const summary = Object.entries(extensions)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 8)
  .map(([ext, n]) => `${n} ${ext}`)
  .join(", ")
// Emits: "Workspace: 47 .ts, 12 .py, 3 .c files"
```

Skip for non-git workspaces. Cap at top 8 extensions.

---

## Results

**Success metrics:**

- P0: Zero doom-loop-induced timeouts on terminal-bench-2 (currently estimated: several per full run)
- P1: Measurable reduction in consecutive identical tool call sequences per task
- P2: No silent codesearch failures in isolated Docker environments
- Overall: proto + Claude Opus 4.6 scores >= 78% on terminal-bench-2 (ForgeCode at 80.2%)

**How to verify:**

```bash
# Run full terminal-bench-2 suite
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path tools.harbor_agent.proto_agent:ProtoAgent \
  -m cli/claude-opus-4-6 \
  --job-name opus-benchmark-v1 -n 1 -y

# Check results
cat jobs/opus-benchmark-v1/result.json
```

Compare timeout rate (P0), partial-pass tasks (P1, P3), and mean score before/after each fix.

---

## Constraints

- **Interactive mode must not regress.** All doom loop and permission changes only alter behavior when `--yolo` is active and there is no pending user interaction. The TUI experience is unchanged.
- **Codesearch: Exa API remains primary.** Ripgrep is fallback only. Default happy path unchanged.
- **Compaction changes must not increase token cost.** Structured format should be tighter than unstructured prose summaries.
- **No new required dependencies.** All features use existing stdlib, Bun APIs, and the existing ripgrep integration.

---

## Additional Context

### Why ForgeCode Scores 5% Higher Than Capy (Same Model)

Both use Claude Opus 4.6. ForgeCode has:

- Doom loop auto-injection (Capy likely does not)
- Compaction with deduplication transformer pipeline — keeps only the LAST read per file path in summaries, dramatically reducing summary size for long tasks
- Tool error reflection

The harness accounts for ~4-5 tasks on an 89-task benchmark. These are exactly the tasks where agents get stuck in loops, exhaust context, or make stale-state decisions.

### Proto's Existing Advantages Over ForgeCode

Proto is already competitive or ahead in several areas:

| Feature                                     | Proto                 | ForgeCode          |
| ------------------------------------------- | --------------------- | ------------------ |
| Agent teams (explorer/implementer/verifier) | Yes                   | No                 |
| LSP integration                             | Yes                   | No                 |
| `--append-system-prompt` flag               | Yes                   | No                 |
| AI-powered compaction                       | Yes                   | Yes                |
| Doom loop detection                         | Yes (blocks in yolo)  | Yes (auto-injects) |
| Todo tool                                   | Yes                   | Yes                |
| Tool truncation                             | Yes (50KB/2000 lines) | Yes (configurable) |
| Apply patch                                 | Yes                   | Yes                |
| Semantic code search                        | Exa API (external)    | Local embeddings   |

### Relevant Source Files

| File                                                 | Relevance                                 |
| ---------------------------------------------------- | ----------------------------------------- |
| `packages/opencode/src/permission/next.ts:131-160`   | Doom loop promise — P0 fix here           |
| `packages/opencode/src/session/processor.ts:160-178` | Doom loop trigger — P0 fix here           |
| `packages/opencode/src/tool/codesearch.ts`           | Exa API call — P2 fix here                |
| `packages/opencode/src/session/compaction.ts`        | Prune + AI summary — P4 fix here          |
| `packages/opencode/src/session/system.ts`            | Environment prompt assembly — P5 fix here |
| `packages/opencode/src/session/prompt/anthropic.txt` | Main Claude system prompt                 |

### ForgeCode Reference Implementations

| Feature                     | ForgeCode file                                     |
| --------------------------- | -------------------------------------------------- |
| Doom loop auto-inject       | `crates/forge_app/src/hooks/doom_loop.rs`          |
| Tool error reflection       | `templates/forge-partial-tool-error-reflection.md` |
| External file tracking      | `crates/forge_app/src/changed_files.rs`            |
| Compaction summary template | `templates/forge-partial-summary-frame.md`         |
| Workspace stats             | `crates/forge_app/src/system_prompt.rs`            |
| Compaction config           | `forge.default.yaml` (compact block)               |
