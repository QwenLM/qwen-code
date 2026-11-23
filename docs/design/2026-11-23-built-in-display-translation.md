# Built-in display translation

[English](2026-11-23-built-in-display-translation.md) | [简体中文](2026-11-23-built-in-display-translation.zh-CN.md)

Status: implemented. This adds a setting that shows the model's replies and opened thoughts translated into Simplified Chinese or English, tracked in #13749. Translation uses the reply and thinking rows described in [Mod reply rows in the Web Shell](2026-11-18-mod-rows-in-web-shell.md) and [Mod thinking rows in the Web Shell](2026-11-20-mod-thinking-rows-in-web-shell.md).

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

`general.displayLanguage` is an enum with the values `off`, `zh-CN` and `en`, and defaults to `off`. Its label is "Language: Display Translation", next to "Language: UI" (`general.language`) and "Language: Model" (`general.outputLanguage`). The user or system controls the extra model calls. Workspace settings cannot set this key.

The target is read when a session starts and stays fixed for that session, so the setting requires a restart. A row's cached answer is keyed on the row's component and props, not on the target, so a target that changed mid-session would answer rows from the cache in the old language. The Web Shell applies a change to the sessions it starts after the change, like `experimental.mods`. It does not follow the Web Shell's own interface language either: two tabs in different interface languages share one session and its cache.

### Built-in translation after Mod rendering

The CLI translates rows after installed Mods render them. It shares the row requests, serial row scheduling, 30-second deadline, and session cache with Mod rendering. Translation has no Mod slot, and its model request runs outside the queue that handles prompts and tools.

Translation runs where the host draws `AssistantMessage` or `Thinking` rows. The owning session verifies Web Shell rows against its completed reply or thinking output, including reply text before a visible tool preparation and prose split around Insight cards. It checks the active transcript again at dispatch and before returning the answer. The cache answers a reload, a second tab or a re-opened thought.

The user guide's translation example now points to this setting for these two languages, and stays as an example of building such a Mod.

### Gates

Installed Mods run third-party code, so they need `experimental.mods` and a trusted workspace. The built-in translation can run with the user's setting in an untrusted workspace and with `experimental.mods` off.

Every other gate still applies to it. They describe sessions where an administrator or the user turned hooks off, or where Mods cannot run or have nothing to draw:

- `disableAllHooks`;
- managed hooks;
- bare mode;
- safe mode;
- a sandbox;
- an execution environment;
- a session run by a workspace agent.

A translation failure keeps the row's existing content. Installed Mods keep their existing initialization behavior.

### Which blocks are translated

The language check reads the Markdown prose and skips fenced, indented and inline code. For Han and Latin prose, a block counts as Chinese when it has at least as many Han characters as Latin words. Prose with letters from another script is eligible for translation. A code-only block is left as it is.

- Target `zh-CN`: Simplified Chinese blocks are left as they are. Traditional Chinese prose can be translated.
- Target `en`: the language check leaves Latin prose as it is when Latin words outnumber Han characters.

This compares characters with words because a Chinese sentence often carries English identifiers. Comparing letters, as the guide's example does, would count `useState` as eight English signs against one Chinese word. For a Chinese target that only means a few extra calls; for an English target it would leave such a Chinese sentence untranslated.

### The model call

Translation uses the Mod model service with the `haiku` alias, which selects the session's fast model or falls back to the session model. The call requests no thinking, has a 25-second timeout inside the row's 30-second deadline and has a limit of 8,192 output tokens. The prompt asks for a complete translation ending with a fixed line. If the answer is empty, lacks the end line, carries the host's truncation marker or changes the displayed code, the row keeps its previous text.

The call sends the text of each translated block to the fast model's endpoint. When the fast model uses another provider than the session model, that provider receives the text.

## Validation and acceptance

Unit tests:

- Settings: only `zh-CN` and `en` turn the translation on. A workspace value leaves the user setting in effect.
- Mod session:
  - With only the user setting on, translation works in an untrusted workspace. Installed Mods still require their own opt-in and workspace trust.
  - Bare mode and `disableAllHooks` keep it off.
  - Translation runs after installed Mods, preserves all 32 installed slots, and leaves prompt dispatch free while the translation provider responds.
  - A host that draws no reply or thinking rows does not translate.
- Translation:
  - Each target skips blocks already in that language and code-only blocks. Traditional Chinese is eligible for the Simplified Chinese target.
  - It translates other eligible blocks through the fast-model alias.
  - It preserves code and leaves the original on an unanswered call.

The `qwen-serve-mod-rows` integration test uses a fake model to translate session reply and thinking rows with the setting alone. A row absent from the session makes no translation call.

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
