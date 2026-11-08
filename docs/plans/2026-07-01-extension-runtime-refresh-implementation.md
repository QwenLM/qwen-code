# Extension Runtime Refresh Implementation Plan

Tracking issue: https://github.com/QwenLM/qwen-code/issues/3696

Working branch: `feat/extension-runtime-refresh`

## Summary

Qwen Code should keep the existing user experience where extension UI
mutations take effect automatically. Installing, updating, enabling, disabling,
or uninstalling an extension should continue to refresh runtime state without
requiring the user to run a manual command.

The remaining work is to make that automatic path complete, cheaper, and more
visible to the model. A separate `/reload-plugins` path should be added later
for external file changes that Qwen Code did not initiate, such as editing
installed extension files by hand.

## Current Behavior

`ExtensionManager` already refreshes part of the runtime after extension
mutations:

```text
enable/disable/install/update/uninstall
  -> ExtensionManager.refreshTools()
  -> refreshMemory()
      -> ToolRegistry.restartMcpServers()
      -> SkillManager.refreshCache()
      -> SubagentManager.refreshCache()
      -> refreshHierarchicalMemory()
```

This is useful but incomplete:

- MCP refresh is currently too expensive because it restarts all MCP servers.
- Commands are rebuilt indirectly through UI-layer command reload behavior.
- Hooks are not part of the extension runtime refresh orchestration.
- LSP server configuration from extensions is not reinitialized at runtime.
- Model-facing availability notices are asymmetric:
  - skills and model-invocable commands announce additions, but not removals;
  - MCP tools announce additions, but not removals;
  - agents update the Agent tool schema/description, but do not send an
    explicit added/removed agent reminder.

## Design Direction

### Keep Automatic Mutation Refresh

Extension UI mutations should remain automatic. This differs from Claude Code's
plugin flow, where plugin mutations primarily set a stale flag and ask the user
to run `/reload-plugins`.

For Qwen Code, automatic mutation refresh is the better default because it
preserves the current UX: when a user toggles an extension, the extension should
actually become usable or unusable in the running session.

### Add Manual Reload Only for External Changes

`/reload-plugins` should be a repair/resync path for file changes outside Qwen
Code's mutation APIs:

- a user edits files under an installed extension directory;
- an external process updates extension contents;
- a marketplace/local extension source changes on disk;
- a watcher sees a change but should not auto-refresh during noisy file writes.

This command should reuse the same runtime refresh orchestration as automatic
mutations.

### Separate Runtime Refresh from Model Notification

Refreshing runtime state is not enough. The model also needs an accurate view of
which capabilities are available.

Runtime refresh updates what can actually execute. Model notification updates
what the model believes it can call. These are related but separate concerns.

## Subsystem Behavior

### Skills

Extension skills are loaded by `SkillManager.refreshCache()` from active
extensions. `SkillTool.refreshSkills()` updates the in-memory runtime sets.

Problem: the model-facing `<available_skills>` path is currently add-only after
startup. Disabling an extension removes the skill from runtime state, but the
old listing may remain in conversation history.

Planned behavior:

- keep runtime refresh through `SkillManager.refreshCache()`;
- after extension runtime refresh, provide a way to send the current complete
  available skills/commands list, or an equivalent clear delta;
- avoid relying only on "new skills became available" reminders for extension
  mutation changes.

### Commands

Extension commands are user-visible slash commands by default. Some are also
model-visible when `modelInvocable === true`; those enter the Skill tool's
available-skill list and can be invoked by name through `SkillTool`.

Problem: there is no core command manager. Command reload is a CLI/UI-layer
operation, and extension mutations do not have a clear command refresh contract.

Planned behavior:

- make command reload an explicit part of extension runtime refresh where the
  CLI/TUI layer is available;
- ensure model-invocable extension commands update the Skill tool provider
  before model-facing skill reminders are emitted;
- keep this minimal and avoid moving the entire command system into core.

### MCP

Extension MCP server config is merged through `Config.getMergedMcpServers()`.

Problem: extension mutations currently call `restartMcpServers()`, which
restarts and rediscovers all MCP servers.

Planned behavior:

- reuse or extend the existing incremental MCP reconcile path;
- after extension cache state is updated, reconcile against the latest merged
  MCP map;
- connect added servers, disconnect removed servers, and restart only changed
  servers;
- keep existing added MCP tool reminders;
- add a removed MCP tool reminder so disabling an extension does not leave the
  model relying on stale tool availability context.

### Agents

Extension agents are loaded by `SubagentManager.refreshCache()`. `AgentTool`
listens for subagent changes and updates its description and `subagent_type`
schema enum, then calls `geminiClient.setTools()`.

Problem: this updates runtime/tool schema, but there is no explicit
conversation reminder for added or removed agent types. In practice, the model
may not notice new extension agents unless prompted.

Planned behavior:

- keep `SubagentManager.refreshCache()` and `AgentTool` schema refresh;
- add a model-facing added/removed agent-type reminder, similar in intent to
  Claude Code's `agent_listing_delta`;
- do not make each agent a separate tool. Agents remain selected through the
  `Agent` tool's `subagent_type` parameter.

### LSP

Extension `lspServers` can be read by the LSP config loader.

Problem: LSP startup currently initializes the native LSP service once. Runtime
extension changes do not reinitialize LSP server configuration.

Planned behavior:

- add an optional LSP reinitialization hook to extension runtime refresh;
- call it when LSP is enabled and the API is available;
- do not add a model-facing reminder for LSP initially, because LSP is exposed
  as a fixed `lsp` tool and server state is better surfaced through status and
  tool results.

### Hooks

Extension hooks should be treated as runtime extension components.

Problem: extension mutation refresh does not currently have a clear hook reload
step.

Planned behavior:

- add hook reload to the extension runtime refresh orchestration;
- disabling/uninstalling an extension should remove its hooks;
- enabling/installing/updating an extension should register its current hooks.

## Proposed PR Sequence

### PR 1: Shared Extension Runtime Refresh Orchestrator

Create a small shared orchestration function used by extension mutations.

Scope:

- preserve current behavior;
- keep automatic extension mutation refresh;
- move the current refresh sequence behind one function;
- do not add watcher support;
- do not add `/reload-plugins`;
- do not change model reminders;
- MCP may still use the existing full restart in this PR.

Expected value:

- gives later PRs one place to attach commands, hooks, LSP, MCP reconcile, and
  model notifications;
- keeps review focused on structure, not behavior changes.

### PR 2: Complete Automatic Mutation Refresh

Extend the orchestrator to refresh all runtime components that should update
after extension UI mutations.

Scope:

- commands reload when the CLI/TUI command service is available;
- hooks reload;
- optional LSP reinitialization;
- keep skills, agents, and memory refresh;
- keep MCP behavior unchanged unless a minimal no-risk integration is already
  available.

Expected value:

- extension enable/disable/install/update/uninstall becomes more complete
  without changing the user-facing automatic-refresh model.

### PR 3: Incremental MCP Refresh for Extension Mutations

Replace full MCP restart with incremental reconcile for extension-driven
changes.

Scope:

- reconcile against the latest merged MCP config after extension cache changes;
- avoid restarting unrelated MCP servers;
- keep existing event/update behavior so `setTools()` still runs through the
  MCP update path.

Expected value:

- reduces side effects and latency when toggling extensions.

### PR 4: Model-Facing Availability Notifications

Fix stale model-visible capability lists.

Scope:

- send a current complete skills/model-invocable commands listing, or equivalent
  clear delta, after extension refresh changes that affect skills/commands;
- add removed MCP tool reminders;
- add agent added/removed reminders;
- avoid adding an LSP reminder initially.

Expected value:

- the model's conversation context matches runtime availability after extension
  changes.

### PR 5: `/reload-plugins`

Add a manual reload command for external extension file changes.

Scope:

- reuse the shared extension runtime refresh orchestrator;
- report a concise refresh summary;
- do not replace automatic mutation refresh;
- clear any stale state introduced by the later watcher PR.

Expected value:

- users have a manual repair path when file watching detects changes or when
  auto-detection misses a change.

### PR 6: Extension File Watcher and Stale Notification

Detect external extension file changes and notify the user.

Scope:

- watch a conservative allowlist of extension-related files:
  - `qwen-extension.json`;
  - `.qwen-extension-install.json`;
  - extension enablement, preferences, and source metadata;
  - `commands/**`;
  - `skills/**`;
  - `agents/**`;
  - `hooks/**`;
  - referenced LSP config files;
  - extension context files such as `GEMINI.md`;
- mark extension runtime as stale;
- show a UI notification suggesting `/reload-plugins`;
- do not automatically reload on every file event.

Expected value:

- external file changes are discoverable without making runtime refresh noisy or
  fragile.

## Non-Goals

- Do not replace Qwen Code's automatic extension mutation behavior with a
  mandatory manual reload flow.
- Do not introduce a broad generic refresh framework before concrete call sites
  need it.
- Do not make each agent type a separate model tool.
- Do not make LSP availability reminders part of the first implementation.
- Do not automatically reload every extension file watcher event.

## Open Questions

- What is the smallest stable API for command reload from extension runtime
  refresh without over-coupling core and CLI?
- Should skills/commands use a full current listing after extension refresh, or
  an added/removed delta? Full listing is simpler and closer to the current
  `<available_skills>` model.
- Should removed MCP tool reminders include all removed tools, or group by
  extension/server to reduce noise?
- Which existing hook reload function should become the public orchestration
  point?
- How should `/reload-plugins` behave in non-interactive mode, if at all?

## Tracking Notes

Use this document to keep PR scope narrow. Each PR should update this file when
its part of the plan is completed or intentionally changed.
