# Lazy Tool Registration / Startup Optimization Summary

## Background

Issue: `QwenLM/qwen-code#3221`

The startup path was eagerly loading nearly all tool modules before the CLI became interactive. Two main code paths caused this:

1. `packages/core/src/config/config.ts`
   - statically imported many tool modules
   - instantiated or registered them during config initialization
2. `packages/core/src/index.ts`
   - re-exported many tool modules from the core barrel
   - caused module evaluation whenever consumers imported from `@qwen-code/qwen-code-core`

Because many tool modules pull in heavy transitive dependencies, this made startup do much more work than necessary.

## Goal

Delay loading tool modules until they are actually needed, while preserving:

- tool discovery behavior
- permission checks
- tool schemas/function declarations
- subagent/tool filtering behavior
- MCP reconnect behavior
- test coverage and runtime compatibility

## Final Design

### 1. Split "registered" from "loaded"

`ToolRegistry` now supports lazy factories in addition to already-instantiated tools.

New capability:

- register a tool factory without loading the tool module immediately
- load a single tool on demand
- warm all pending tools only at boundaries that truly need the full set

Key additions in `packages/core/src/tools/tool-registry.ts`:

- `ToolFactory`
- `registerFactory(name, factory)`
- `ensureTool(name)`
- `warmAll()`
- `getAllToolNames()` updated to include both loaded tools and pending factories

This keeps startup cheap while still allowing eager access when specific code paths need all tools materialized.

### 2. `config.ts` now lazy-registers tool factories

`packages/core/src/config/config.ts` was changed from eager static imports to lazy dynamic imports.

Instead of importing every tool at module load time, `createToolRegistry()` now registers async factories like:

```ts
await registerLazy(ToolNames.AGENT, async () => {
  const { AgentTool } = await import('../tools/agent.js');
  return new AgentTool(this);
});
```

This preserves existing permission gating because enablement checks still happen during registry creation; only the actual module load and instantiation are deferred.

Conditional registrations were preserved for:

- grep / ripgrep
- web search
- cron
- LSP-related tools
- other environment-dependent tools

### 3. Remove eager tool exports from the core barrel

`packages/core/src/index.ts` no longer re-exports the heavy individual tool modules.

It now keeps only:

- lightweight tool infra exports (`tool-names`, `tool-registry`, `tools`, etc.)
- MCP infrastructure exports
- a few small extracted utilities/types

This avoids loading all tool modules just because another package imported the core barrel.

### 4. Extract lightweight helpers from heavy tool modules

To avoid keeping the barrel coupled to heavy tool files, two small helpers were extracted:

#### `packages/core/src/tools/memory-config.ts`

Contains lightweight memory filename/config constants and helpers previously tied to `memoryTool.ts`.

#### `packages/core/src/tools/skill-utils.ts`

Contains:

```ts
export function buildSkillLlmContent(baseDir: string, body: string): string;
```

`packages/core/src/tools/skill.ts` now re-exports this helper from the lightweight utility file.

This allows external imports of small shared utilities without eagerly loading the full skill tool implementation.

## Runtime Call Site Changes

After introducing lazy registration, several call sites had to distinguish between:

- needing one specific tool now → `ensureTool(name)`
- needing the full realized tool set now → `warmAll()` first

### Updated patterns

#### Single-tool access

Changed from:

```ts
toolRegistry.getTool(name);
```

To:

```ts
await toolRegistry.ensureTool(name);
```

This was applied in places such as:

- `packages/core/src/core/coreToolScheduler.ts`
- `packages/core/src/core/client.ts`
- `packages/core/src/tools/mcp-tool.ts`
- `packages/core/src/followup/speculation.ts`
- `packages/core/src/agents/runtime/agent-core.ts`

#### Bulk access

Where code needed all tool declarations or all realized tool metadata, it now does:

```ts
await toolRegistry.warmAll();
```

This was applied in places such as:

- `packages/core/src/core/client.ts`
- `packages/core/src/core/geminiChat.ts`
- `packages/core/src/agents/runtime/agent-core.ts`
- `packages/core/src/subagents/subagent-manager.ts`

## Important File-Level Changes

### `packages/core/src/tools/tool-registry.ts`

Implemented the lazy registry model.

### `packages/core/src/config/config.ts`

Replaced eager tool imports/registration with lazy factory registration.

### `packages/core/src/index.ts`

Removed eager `export *` tool-module re-exports and kept only safe/lightweight exports.

### `packages/core/src/tools/skill.ts`

Now consumes and re-exports `buildSkillLlmContent` from `skill-utils.ts`.

### `packages/core/src/tools/mcp-tool.ts`

Reconnect path now resolves the replacement tool with:

```ts
await toolRegistry.ensureTool(
  `mcp__${this.serverName}__${this.serverToolName}`,
);
```

### `packages/core/src/subagents/subagent-manager.ts`

Tool-name normalization now warms the registry before inspecting `getAllTools()`:

```ts
await toolRegistry.warmAll();
const allTools = toolRegistry.getAllTools();
```

### `packages/core/src/core/client.ts`

Client startup/tool setup paths now warm the registry when they need the full tool set, and specific checks use lazy loading.

### `packages/core/src/core/coreToolScheduler.ts`

Tool execution and skill-related error messaging now use lazy tool resolution.

## External/CLI Compatibility Fixes

A couple of downstream references were also adjusted to avoid forcing eager tool imports:

- references to `ExitPlanModeTool.Name` were replaced with `ToolNames.EXIT_PLAN_MODE`
- tests and call sites that assumed eager tool availability were updated to use the lazy registry shape

## Test Fixes Required by the New Lazy API

Most remaining work after the main implementation was updating tests that mocked `ToolRegistry` with the old interface.

The new implementation introduced two new expectations in tests:

- some paths now call `warmAll()`
- some paths now call `ensureTool()` instead of `getTool()`

Updated test files included:

- `packages/core/src/core/coreToolScheduler.test.ts`
- `packages/cli/src/ui/hooks/useToolScheduler.test.ts`
- `packages/core/src/subagents/subagent-manager.test.ts`
- `packages/core/src/tools/mcp-tool.test.ts`
- `packages/core/src/core/client.test.ts`
- `packages/core/src/agents/runtime/agent-headless.test.ts`
- `packages/core/src/core/nonInteractiveToolExecutor.test.ts`
- `packages/core/src/config/config.test.ts`

### Common mock update patterns

#### Add `warmAll`

```ts
warmAll: vi.fn().mockResolvedValue(undefined);
```

#### Add `ensureTool`

When the old mock already had `getTool`, the simplest compatible form was:

```ts
ensureTool: vi.fn(async (name: string) => mockToolRegistry.getTool(name));
```

This preserved existing test behavior with minimal churn.

## Validation Results

### Targeted tests

Passed:

- `src/core/coreToolScheduler.test.ts`
- `src/tools/tool-registry.test.ts`
- `src/config/config.test.ts`
- `src/ui/hooks/useToolScheduler.test.ts`
- `src/subagents/subagent-manager.test.ts`
- `src/tools/mcp-tool.test.ts`
- `src/core/client.test.ts`
- `src/agents/runtime/agent-headless.test.ts`
- `src/core/nonInteractiveToolExecutor.test.ts`

### Build

Passed:

- `npm run build`

### Full test suite

Passed:

- CLI workspace: `254 passed`
- Core workspace: `210 passed`
- SDK TypeScript workspace: `6 passed`
- VS Code IDE Companion workspace: `28 passed`

## Outcome

The startup path no longer needs to eagerly evaluate the full tool graph during config/core-barrel import.

The final implementation:

- removes the two main eager-load paths
- keeps tool behavior functionally compatible
- preserves permission checks and dynamic conditions
- updates runtime call sites to explicit lazy semantics
- restores full test coverage across all workspaces

## Follow-up Notes

Potential follow-up work if we want to quantify the win more explicitly:

1. add a lightweight startup benchmark around config/CLI init
2. compare cold-start timings before vs after
3. optionally capture which tool modules remain on the startup critical path

But functionally, the lazy tool registration change itself is complete and validated.
