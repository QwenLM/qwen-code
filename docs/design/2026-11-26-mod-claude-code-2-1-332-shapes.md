# Mods written for Claude Code 2.1.332

[English](2026-11-26-mod-claude-code-2-1-332-shapes.md) | [简体中文](2026-11-26-mod-claude-code-2-1-332-shapes.zh-CN.md)

Status: proposed. Tracked in #13749. This follows the Claude Code 2.1.332 plugin API declarations. It is the first slice of the plan that loads and draws Mods written against the current Claude Code release.

## Problem and current behavior

The Mod runtime recognizes the events and shapes of Claude Code 2.1.318. Between 2.1.318 and 2.1.332, Claude Code added event names and widened several shapes that a Mod supplies. Qwen Code checks each of those shapes against a strict list, so a Mod that uses one of the new names or fields fails here, though it would load and draw in Claude Code:

- **Hooks on new events.** `on()` rejects a name it does not know. When any installed Mod registers `session.stop`, `tool.run`, `ui.tip` or `vcs.*`, Mod initialization fails for the whole session, so every other Mod stops working too.
- **Invalidating new events.** `$.ui.invalidate('tool.offer')` throws. The same applies to `tool.list` and `ui.offer`.
- **Command specifications.** `$.command.register` accepts only `name`, `description` and `argumentHint`. A specification that also carries `aliases`, `isHidden`, `isTerminalOnly`, `isWorkspaceFree`, or the older `immediate`, is refused.
- **Command answers.** A `command.run` answer that carries `isTextDisplayOnly` is refused.
- **Turn completion answers.** A `turn.complete` answer that carries `by` is refused.
- **The band above the prompt.** A tree is refused if it uses `Progress`, `maxLines`, `wrap: "clip"`, or a Box's `overflowX` or `mono`.

Observed failures are recorded in [Baseline](#baseline).

## Goals and non-goals

Goals:

- A Mod written for 2.1.332 that uses only capabilities Qwen Code runs loads, registers its commands and draws its band.
- Each new field is either honored or accepted and dropped. The rule: honor a field when ignoring it would make the Mod do what its author opted out of; otherwise validate its shape and drop it.
- Names Qwen Code does not run keep the existing behavior: they load, their hooks are skipped, and each plugin reports them once.

Non-goals:

- Running any new event (`session.stop`, `tool.run`, `tool.judge`, `tool.offer`, `ui.tip`, `vcs.*` and the rest).
- New `$` methods (`$.agent.call`, `$.theme.*`, `$.wasm.compile` and the rest), and new render sites (`StatusLine`, `BesidePrompt` and the rest).
- Command `context` and `exitCode`, which arrive with model context in a later slice.

## Compatibility contract

These follow the 2.1.332 declarations.

1. **Event names.** The recognized table becomes the 2.1.332 one: engine events, `$` API events and `classic.*` settings hook events. It adds 25 names, including `classic.PreSkillShellCommand`, and new namespaces such as `vcs`. `$.session.version()` reports `claudeCode: "2.1.332"`.
2. **Invalidatable events.** The list `$.ui.invalidate` accepts gains `tool.list`, `tool.offer` and `ui.offer`.
3. **Command specification.**
   - `aliases`: up to 8 names, each spelled as `name` may be. `command.run` receives the canonical `name` whichever was typed. An alias that another Mod command already holds as a name or alias, compared case-insensitively, refuses the whole registration.
   - `isTerminalOnly`: outside the interactive terminal it is not listed, and typing it reports that it is unavailable instead of running it.
   - `immediate`, `isHidden` and `isWorkspaceFree`: accepted as `true`.
4. **Command answer.** `isTextDisplayOnly: true` is accepted.
5. **Turn completion answer.** `by`, a list of strings, is accepted. It belongs to the engine, so the engine replaces whatever a hook puts there.
6. **Band elements and props.**
   - `Progress` is a leaf element with `label` (not blank), `value`, `max`, `valueText` and `color`.
   - Text accepts `maxLines`, a whole number from 1, and `wrap: "clip"`.
   - Box accepts `overflowX: "visible" | "scroll"` and `mono`.
   - A Box that sets `mono` holds no engine drawing, as one with a size holds none.
   - `anchor` stays refused: it is only valid in `BesidePrompt`, which Qwen Code does not draw.

## Qwen design decisions

- **`ui.backdrop` stays recognized.** Claude Code 2.1.332 dropped it. A Mod written for 2.1.318–2.1.331 may still name it; keeping it recognized lets that Mod load with the hook skipped rather than failing.
- **Dropped fields go no further than validation.** `immediate`, `isHidden`, `isWorkspaceFree`, `isTextDisplayOnly` and `by` are checked for shape and then removed in the worker. No host type gains a field nobody reads.
  - `immediate`: a Mod command typed during a turn already waits for the turn, which is the behavior without the flag. Running it mid-turn would also meet the worker's one-dispatch-at-a-time rule.
  - `isHidden`: Qwen Code's hidden commands are kept out of every lookup, so a hidden command could not be typed either. The command is listed as any other. Ignoring the flag only shows a command its author meant to keep quiet; it runs nothing the author did not ask for.
  - `isWorkspaceFree`: Qwen Code has no remote-attached terminal for it to change.
  - `isTextDisplayOnly`: a Mod command's text is already an informational line that never enters a model request.
  - `by`: Qwen Code already names the plugin on each note it shows.
- **Aliases use Qwen Code's existing resolution.** Primary names win over aliases, so an alias that matches a built-in or another extension's command name does not run the Mod command. Two Mods are kept from sharing a name or alias at registration time.
- **`isTerminalOnly` in headless runs.** The command is declared for interactive mode alone. A headless run already knows commands of other modes and refuses them with `The command "/<name>" is not supported in this mode.`, so the line never becomes a model prompt and no new message is needed.
- **How the terminal draws the new props.** Each renderer's look is Qwen Code's own:
  - `wrap: "clip"` draws as `truncate-end`, marked as each terminal marks an end cut: Ink with `…`, OpenTUI with no mark.
  - `maxLines: 1` without a cutting wrap draws as `truncate-end`, the same as a one-row cut. A larger `maxLines` clips the Text to that many rows.
  - `overflowX: "scroll"` cuts each Text inside at the Box's edge, as `truncate-end` unless its own wrap already cuts. Inside such a Box, `maxLines` has no effect, and a Box with its own `width` keeps what it holds as written.
  - `mono` changes nothing on a terminal, which is always monospaced.
  - `Progress` draws its label, a ten-cell bar and `valueText`, or the whole percent when `valueText` is absent. A Progress with no known end draws the label and its `valueText`, or a dim ellipsis without one.
- **`blur` stays refused.** Claude Code accepts it only on a Box that sits where a blurred layer may: absolutely placed or holding one that is, holding only Box, Text and a non-interactive Svg, at most four in a tree, and none in a tree that holds an engine node. A terminal draws it sharp, so accepting the value alone would let Qwen Code draw trees Claude Code refuses. Its placement rules come with the slice that checks them.
- **Both terminals.** Ink and OpenTUI draw these the same way through the shared band helpers. `modBandLayout` strips `overflowX` and `mono`, so neither renderer receives a prop it does not know.

## Host interface

This slice adds nothing the host must provide. The worker validates and drops fields; the command loader reads `aliases` and `isTerminalOnly` from the declarations it already receives; and the renderers read the tree they already draw.

## Baseline

Observed on `main` at `a37a7612c9` with the bundled CLI, an isolated `HOME` and a loopback model fixture:

| Mod                                                                          | Observed                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| One installed Mod hooks `session.stop`                                       | Mod initialization fails for the whole session. A headless run exits 1 before any model request, and no other Mod runs. |
| `$.command.register` with `aliases`, or with `isTerminalOnly` and `isHidden` | `Invalid Mod command specification.`; the command is missing, so a headless `/pa hi` goes to the model as a prompt.     |
| `$.ui.invalidate('tool.offer')`                                              | Throws `$.ui.invalidate takes ui.render or a cached-answer event, not tool.offer`.                                      |
| `turn.complete` answers `{ ...next, text, by }`                              | The note disappears; no line says why. Without `by` the same note is shown.                                             |
| Band tree with `maxLines`, `wrap: "clip"` and `overflowX`                    | The band stays blank in Ink.                                                                                            |
| `$.ui.resolve(e).Progress`                                                   | `undefined`.                                                                                                            |
| Claude Code's token-weather sample, unchanged                                | Draws its band in Ink and in OpenTUI (`QWEN_TUI_RENDERER=opentui` under Bun).                                           |

## Validation and acceptance

- Unit tests:
  - the event table equals the 2.1.332 declaration set;
  - each new field is accepted, the ones Qwen Code runs reach the command loader, and a truly unknown key is still refused;
  - alias conflicts between Mods refuse the registration;
  - a `Progress` with a blank `label` is refused;
  - `mono` blocks an engine node;
  - Ink and OpenTUI draw `Progress`, `maxLines`, `clip` and `overflowX` as described.
- Integration tests (`integration-tests/cli/mods-claude-332.test.ts`) use a Mod fixture written for this change. It hooks `session.stop` and `vcs.*`, registers a command with an alias and one with `isTerminalOnly`, and returns `by`. The tests check that the plugin loads and its note shows, that the alias runs with the canonical name, and that a headless terminal-only command is refused with no model request.
- Interactive check: Claude Code's token-weather sample, run unchanged, draws its band in Ink and OpenTUI. A probe Mod draws `Progress`, `maxLines` and `clip` in both terminals.

## Left for later slices

Claude Code 2.1.332 also changed these on surfaces Qwen Code runs. This slice leaves them as they were:

- **The band above the prompt is one row per plugin.** `AbovePrompt` is asked once for each plugin that hooks it, with `e.plugin`, and `AbovePromptList` stacks the rows. Its input also gained `isCollapsed`. Qwen Code still draws one band from one chain, so a hook that answers without `next(e)` hides the rows of the plugins after it. Goes with the Pane slice (S2).
- **`blur`** and its placement rules, above. S2.
- **`tool.call`**: a hook that checks the result can refuse in its `.catch` even after `next` was called. **`tool.check`**: the `op` and `isCeilingUnread` facts, and an ask that names only the plugin that asked. With the file and process slice (S3).
- **`turn.start`** for agents, which every hook now hears, and the three-second wait for these hooks before an agent's first request. With the model-context slice (S4).
- **`CommandPresentation.isColorless`**, and a `$.model.complete` that meets a usage limit rejecting at once with the API's error. A later S1 change.

## Risks and open questions

- `maxLines` above 1 clips rows without an ellipsis on the last row.
- A Mod that uses `isTerminalOnly` to hide a command from ACP clients sees no change: ACP does not offer Mod commands yet.
- A command marked `isHidden` shows in typeahead and `/help`.
