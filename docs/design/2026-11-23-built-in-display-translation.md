# Built-in display translation

[English](2026-11-23-built-in-display-translation.md) | [简体中文](2026-11-23-built-in-display-translation.zh-CN.md)

Status: implemented. This adds a setting that shows the model's replies and opened thoughts translated into Simplified Chinese or English, tracked in #13749. It ships the translation as a built-in Mod on the reply and thinking rows described in [Mod reply rows in the Web Shell](2026-11-18-mod-rows-in-web-shell.md) and [Mod thinking rows in the Web Shell](2026-11-20-mod-thinking-rows-in-web-shell.md).

## Problem and current behavior

Mods can already rewrite what reply blocks and opened thoughts show, in the Ink and OpenTUI terminals and in the Web Shell. The user guide shows a translation Mod built on that. Using it takes four steps:

- turning on `experimental.mods`;
- trusting the workspace;
- writing three files;
- installing them as an extension.

Without those steps the only translation is the Web Shell's translate button. It sits next to each thought and opens a popover with a translation into the interface language. It does not cover replies, and it does not exist in the terminals.

`general.outputLanguage` is not a replacement. It asks the model to answer in a language, which changes what the model writes and what later turns read. Some users want the model to keep working in its own language and only want to read the result in theirs.

## Goals and non-goals

Goals:

- One setting that shows replies and opened thoughts in Simplified Chinese or English, in the Ink and OpenTUI terminals and the Web Shell.
- The setting works without `experimental.mods`, without installing anything and in untrusted workspaces.
- Only the display changes. The stored conversation, what the model reads, `/copy` and the Web Shell's copy buttons keep the original.
- Blocks already in the target language, and blocks that are only code, are left as they are and cost nothing.

Non-goals:

- Other target languages.
- Removing or changing the Web Shell's translate button. It is to be phased out separately. Until then it stays hidden on thoughts the translation rewrote, as it already is for any Mod rewrite.
- Translating tool output, user prompts, the collapsed thinking rows, subagent views, the session preview, exported transcripts or headless output. None of them is a reply or thinking row.
- The VS Code companion, which does not draw Mod rows.

## Design decisions

### The setting

`general.displayLanguage` is an enum with the values `off`, `zh-CN` and `en`, and defaults to `off`. Its label is "Language: Display Translation", next to "Language: UI" (`general.language`) and "Language: Model" (`general.outputLanguage`). Its description says how it differs from the other two: the model answers as usual and only the display is translated.

The target is read when a session starts and stays fixed for that session, so the setting requires a restart. A row's cached answer is keyed on the row's component and props, not on the target, so a target that changed mid-session would answer rows from the cache in the old language. The Web Shell applies a change to the sessions it starts after the change, like `experimental.mods`. It does not follow the Web Shell's own interface language either: two tabs in different interface languages share one session and its cache.

### A built-in Mod

The translation is a Mod whose source ships inside the CLI, so it uses the same path as an installed Mod:

- the row asks in each surface;
- the one-at-a-time row queue and its 30-second deadline;
- the session's row cache, which answers a reload, a second tab or a re-opened thought;
- `$.model.complete` with the fast model.

No surface gains new drawing code. The Web Shell already asks for rows whenever the daemon offers them, so its message components are unchanged and the export bundle does not grow.

The Mod takes the target as its option and registers one `ui.render` hook for `AssistantMessage` and `Thinking`. It is added to the session's Mods only where the host draws at least one of those sites. Headless runs draw none and do not start it.

It runs after every installed Mod, innermost in the hook chain, so it translates the text the other Mods settled on.

The user guide's translation example now points to this setting for these two languages, and stays as an example of building such a Mod.

### Gates

Installed Mods run third-party code, so they need `experimental.mods` and a trusted workspace. The built-in Mod runs only Qwen Code's own code on the model's own output, so it needs neither: it loads in an untrusted workspace, and with `experimental.mods` off. Installed Mods still load only with both.

Every other gate still applies to it. They describe sessions where an administrator or the user turned hooks off, or where Mods cannot run or have nothing to draw:

- `disableAllHooks`;
- managed hooks;
- bare mode;
- safe mode;
- a sandbox;
- an execution environment;
- a session run by a workspace agent.

With only the built-in Mod loaded, a failure to start it is logged and the session runs untranslated. An installed Mod's failure still stops the session's Mods as it does today, because the built-in Mod shares their runtime.

### Which blocks are translated

A block made only of indented code is left as it is. Any other block is judged on its prose, with closed fences of backticks or tildes and inline code removed, the same as the guide's example. Its Han characters are compared with its Latin words. A block counts as Chinese when it has at least as many Han characters as Latin words. A block with neither is left as it is.

- Target `zh-CN`: Chinese blocks are left as they are.
- Target `en`: blocks that are not Chinese are left as they are.

This compares characters with words because a Chinese sentence often carries English identifiers. Comparing letters, as the guide's example does, would count `useState` as eight English signs against one Chinese word. For a Chinese target that only means a few extra calls; for an English target it would leave such a Chinese sentence untranslated.

### The model call

The hook calls `$.model.complete` with the `haiku` alias, which runs the session's fast model, or the session's model when none is set. The call has no `effort`, so no thinking is requested, a 25-second timeout inside the row's 30-second deadline and a limit of 8,192 output tokens. The system prompt asks for a translation that keeps the Markdown structure, code, paths, URLs, commands and identifiers, followed by a fixed end line. An answer without that line was cut off, for example at the token limit. An answer the host cut to its head and tail for the Mod payload carries the host's truncation marker. Either is incomplete, so like an unanswered call or an empty answer it leaves the block's original text and writes a debug log line.

The call sends the text of each translated block to the fast model's endpoint. When the fast model uses another provider than the session model, that provider receives the text.

## Validation and acceptance

Unit tests:

- Settings: only `zh-CN` and `en` turn the translation on, and either it or `experimental.mods` starts a session's Mods.
- Mod session:
  - With only the setting on, the built-in Mod loads, including in an untrusted workspace. Installed Mods do not load without `experimental.mods`, nor in an untrusted workspace.
  - Bare mode and `disableAllHooks` keep it off.
  - With both on, the built-in Mod runs after the installed ones.
  - A host that draws no reply or thinking rows does not start it.
  - A failed start with only the built-in Mod leaves the session running.
- Built-in Mod:
  - Each target skips blocks already in that language and code-only blocks.
  - It translates the others through the fast-model alias.
  - It leaves the original on an unanswered call.
- Mutation checks: each of 19 mutations of the language rule, the answer handling, the gates, the load order and the failure handling makes a test fail.

The `qwen-serve-mod-rows` integration test gains a case with no extension installed and the setting on: a reply row and a thinking row are answered with the fake model's translation.

In a real Web Shell, and in the Ink and OpenTUI terminals, check both targets with and without a fast model set:

- English output is shown in Chinese, and Chinese output in English.
- Blocks already in the target language and code-only blocks are unchanged.
- Copy buttons copy the original.
- A thought's translate button is hidden once the thought is translated.

Checked on 2026-11-23 with deepseek-v4.1-flash, and deepseek-v4-flash-0731 without thinking as the fast model:

- Web Shell, target `zh-CN` with the fast model: the English reply and the opened thought were shown in Chinese, the thought's translate button was hidden, copying gave the English original, and a reload showed the translations.
- Web Shell, target `en` with no fast model: the Chinese reply was shown in English and copying gave the Chinese original. The model thought in English, so the thought kept its text and its translate button.
- Ink and OpenTUI, target `zh-CN`: the English reply was shown in Chinese, and the stored conversation kept the English.

Acceptance: with `general.displayLanguage` set and nothing else changed, a new session shows completed replies and opened thoughts in the target language in all three interfaces, and the stored conversation keeps the original.

## Risks and open questions

- Every completed block and every opened thought costs one model call per session. A resumed session translates the rows it shows again.
- A fast model that thinks, or a slow one, can miss the 30-second deadline. Such a block keeps its original text.
- A block switches from the original to the translation when its answer arrives, so its height can change.
- In Ink with history in the terminal scrollback (`ui.useTerminalBuffer` off, or a screen reader), printed rows cannot change and are not translated.
- The language rule misjudges text that mixes the two languages about equally. Such a block is either translated or left in the original; neither loses content.
