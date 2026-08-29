# Web Shell compact mode and tool progress

## Goal

Update the existing Web Shell compact mode to hide transcript thinking without changing model behavior and make parallel tool summaries describe every active foreground tool until all tools finish.

## Design

`App` keeps the existing `Ctrl+O` compact-mode shortcut, context, Help terminology, and `ui.compactMode` workspace setting. The setting restores compact mode when the Web Shell loads and is updated when the shortcut toggles the mode. Compact mode no longer switches message bodies to their old condensed cards. Instead, `MessageList` removes thinking rows only from its rendered item list, leaving the transcript and model behavior unchanged.

In compact mode, regular tool groups separated only by hidden thinking are merged within the same activity sequence. Outside compact mode, visible thinking preserves the original interleaved transcript order. User, assistant, system, plan, approval, agent, todo, and question UI boundaries remain separate. Running tool summaries are derived from all active foreground tools and reuse the existing tool descriptions. Completed summaries remain unchanged and appear only after no tool is active. Expanded tool rows reuse the existing tool-kind icons.

Expanded tool rows show locally observed elapsed time while a tool is active and omit it after the tool finishes. Collapsed summaries do not show elapsed time.

## Compatibility

The existing compact-mode concept and persistence path remain unchanged. No new setting, URL parameter, public transcript prop, or `localStorage` key is introduced. The read-only `WebShellTranscript` remains outside compact mode.
