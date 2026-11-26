# Mod compatibility baseline

[English](2026-10-23-mod-compatibility-baseline.md) | [简体中文](2026-10-23-mod-compatibility-baseline.zh-CN.md)

Status: proposed. This document describes the experimental Mod runtime as implemented on `main` at `3d65e23cf6` and three changes that move its Claude Code compatibility baseline from 2.1.296 to 2.1.308. Changes 1 and 2 are under review in #15273 and #15306. Tracking issue: #13749.

## Problem and current behavior

Qwen Code runs a subset of the Claude Code Mod API. A plugin's hooks module exports `register(on, options)`; each `on(event, matcher?, handler)` call adds a registration to a middleware chain whose handlers receive `($, e, next)`. The subset runs in headless sessions and in the Ink and OpenTUI terminals when `experimental.mods` is on and the workspace is trusted.

Each session has one worker thread, and each plugin runs in its own QuickJS environment with no Node, filesystem or network access. Plugins are ordered consumer before dependency provider; within a plugin, registration order sets the chain, and Qwen Code's own behavior is the innermost handler. Hooks receive `session.start`, `session.end`, `command.run`, `tool.call` and `tool.check`. `$` offers `command.register` and `ui.log`, which pass through the same chain as API events. A failed hook is skipped unless its `.catch` answers; a dispatch that cannot hand a hook its input or take back its answer refuses a tool call or withholds a result that already exists. Every ordinary `tool.call` continuation is a fresh native attempt with validation, classic hooks, permissions and approval. `tool.check` can only tighten Qwen Code's own permission decision.

Claude Code shipped 2.1.299 to 2.1.308 in the two weeks after the 2.1.296 pin. Its Mod API gained one event (`prompt.change`) and three `$` methods, and changed several semantics. Three gaps follow:

- A registration for any event outside the supported list fails initialization. A Mod written for Claude Code therefore cannot load in Qwen Code, even for the parts this runtime supports. Claude Code itself rejects only names it does not define.
- A Mod's `ask` from `tool.check` follows the approval mode like any other ask. YOLO approves it automatically, AUTO lets its classifier decide, and the dialog offers "always allow". In Claude Code 2.1.308, an ask a hook makes goes to a person, is denied where nobody can answer, and the event carries `isReadOnly` and `approver`.
- The compatibility contract exists only in the user guide, pinned to 2.1.296, with no stated way to compare a newer release.

## Goals and non-goals

Goals:

- Load Mods written for newer Claude Code releases while running only the supported subset.
- Align `tool.check` with 2.1.308 where it decides who may approve a call.
- Record the compatibility contract and how it moves to a new release.

Non-goals: events or `$` methods beyond `session.version`; rendering, state, streaming, hot reload and ACP entry points. They follow the stages tracked in #13749.

## Compatibility contract

The public API is the Claude Code authoring contract. Qwen Code implements a versioned subset of it:

- Every documented behavior names the Claude Code release it follows. With the changes below, recognized event names come from one release, 2.1.308: its engine events, its `$` API events and its `classic.*` settings hook events, 144 names in total.
- Deliberate differences stay documented in the user guide: one QuickJS environment per plugin, `tool.check` that only tightens a native decision, a PermissionRequest hook that cannot approve a Mod's own ask, plugin settings that workspace settings cannot change, dependency failures that reject startup, and built-in command conflicts that rename the plugin's command.
- Moving to a new release means extracting that release's plugin API declarations, comparing its events, `$` methods and changed semantics with the current pin, updating the event list and tests, and recording the release in the user guide. Claude Code writes those declarations beside every Mod it loads, as `.claude-plugin/types/claude-code/index.d.ts`; they take precedence over its CHANGELOG, which summarizes them.

## Proposed changes

### 1. Skip hooks for events Qwen Code does not run

A registration whose name Claude Code defines, or whose prefix such as `prompt.*` names one of its namespaces, loads even if it matches none of the supported events. It never runs. Duplicate, matcher and capacity rules still apply to it. A name Claude Code does not define, such as `tool.calls`, still rejects initialization.

At startup, each plugin reports its skipped patterns once, where transcript logs appear: an informational line in the terminals, stderr in text mode and `system/ui_log` in JSON modes. The line reads `Hooks for unsupported events will not run: prompt.submit, ui.render`.

A skipped guard does not protect anything, including its `.catch`. A plugin's `unsupportedEvents` setting, read from user or system settings like `toolDialect`, restores the previous refusal with `"reject"`. The default is `"skip"`.

`$.session.version()` lets a Mod adapt. It resolves to `{ version, qwen: { claudeCode, events, methods } }`, where `version` is the Qwen Code version, `claudeCode` is the release whose event names are recognized, and `events` and `methods` list what hooks receive and what `$` offers. Like the other `$` methods, it passes through the chain as an API event that another plugin can observe, answer or deny.

### 2. Align `tool.check` with 2.1.308

The event gains two facts that the engine sets and hooks cannot change. Both are declared on `ToolCheckInput` in the 2.1.308 declarations:

- `isReadOnly: true` when the tool reports the call as read-only: read, search and fetch tools, MCP tools whose server marks them read-only, and shell commands that pass the read-only check. A hook reads its absence as a possible write.
- `approver`: `person` where a dialog can ask the user, `host` where a stream-json host answers permission requests, absent where nobody can answer.

A Mod's own ask, meaning an ask it made or reworded rather than Qwen Code's ask passed up unchanged, becomes a person's decision, as a PreToolUse hook's ask already is:

- YOLO, AUTO_EDIT and the AUTO classifier cannot approve it.
- The dialog shows the Mod's reason and the plugin's name, and hides "always allow".
- Approving a sibling call does not approve it.
- A session where nobody can answer denies it with the Mod's reason.

As with a PreToolUse ask, a PermissionRequest hook can deny the call but cannot answer for the person. This is stricter than Claude Code, which lets such a hook allow it.

The 2.1.308 declarations carry this as engine-set data. The engine names the plugin on an ask a hook answered, `ToolCheckResult.plugin`, and states who can answer, `ToolCheckInput.approver`. The 2.1.304 CHANGELOG instead described a `decider: "person"` field on the hook's answer. By 2.1.308 that field was gone: the engine's answer validation no longer accepts it, and every ask a hook makes is a person's ask. Qwen Code follows 2.1.308.

The merge stays restrictive. A Mod still cannot turn a native ask or deny into allow.

### 3. Pin the contract to 2.1.308

Tests cover the value boundary that Claude Code 2.1.299 tightened: deeply nested values, own `__proto__` keys and getters that throw. They also cover dispatch failures that cannot hand a hook its input or take back its answer. The user guide then moves its baseline to 2.1.308.

## Later stages

The stages in #13749 continue from this baseline, each as a separate change with its own tests:

- Authoring: static validation, generated type declarations and development reload.
- Host APIs: session facts, clock, state and store, then files, processes, HTTP and the model, each with its own permission boundary.
- Prompt and turn events, and `classic.*` events for Qwen Code's settings hooks.
- Tool registration, subagents and ACP entry points.
- Terminal rendering in Ink and OpenTUI, then Web Shell projection.
- Managed tiers.

Claude Code's published samples mark the milestones. Token Weather needs session facts, turn events and the area above the prompt. Replay Theater and Blast Radius add file and process access, buttons and panes.

## Validation and acceptance

- Real QuickJS worker tests cover:
  - skipped registrations, including prefixes, negations, matchers and `.catch`;
  - rejection of misspelled names, unknown namespaces and unknown classic events;
  - the `unsupportedEvents` setting and its precedence;
  - `$.session.version()` through the chain, including another plugin's answer and denial.
- Scheduler tests cover a Mod ask in default, AUTO_EDIT, AUTO, YOLO and PLAN modes, in a terminal, headless and stream-json. They check the dialog reason, hidden "always allow", sibling approval and denial without an answerer. A Mod's ask that only passes Qwen Code's ask up unchanged keeps the native behavior.
- The built CLI checks in headless text and JSON output and in the Ink and OpenTUI terminals:
  - a Mod that hooks unsupported events loads, reports them once and runs its command;
  - `unsupportedEvents: "reject"` refuses it;
  - in a terminal session in YOLO mode, a Mod's ask opens the dialog, and in a headless run in YOLO mode it is denied.

## Risks and open questions

- A skipped guard leaves its call unguarded. The startup line and the `"reject"` setting are the mitigations. A plugin cannot declare this policy in its own manifest, because Claude Code defines no such field.
- YOLO and AUTO users will see dialogs for Mod asks that they previously did not see. This is intended: the Mod asked for a person.
- A Claude Code release that adds an event is rejected until the event list moves to it, as Claude Code itself rejects names it does not know.
