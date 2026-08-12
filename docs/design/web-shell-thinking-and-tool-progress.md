# Web Shell compact mode and tool progress

## Goal

Update the existing Web Shell compact mode to hide transcript thinking without changing model behavior, make parallel tool summaries describe every active foreground tool until all tools finish, and keep thinking/tool elapsed times stable across transcript replay.

## Design

`App` keeps the existing `Ctrl+O` compact-mode shortcut, context, Help terminology, and `ui.compactMode` workspace-setting write. Compact mode no longer switches message bodies to their old condensed cards. Instead, `MessageList` removes thinking rows only from its rendered item list, leaving the transcript and model behavior unchanged.

In compact mode, regular tool groups separated only by hidden thinking are merged within the same activity sequence. Outside compact mode, visible thinking preserves the original interleaved transcript order. User, assistant, system, plan, approval, agent, todo, and question UI boundaries remain separate. Running tool summaries are derived from all active foreground tools and reuse the existing tool descriptions. Completed summaries remain unchanged and appear only after no tool is active. Expanded tool rows reuse the existing tool-kind icons.

Transcript blocks retain the first and latest daemon timestamps. When a block carries an authoritative pair with a positive elapsed interval, thinking and tool messages keep the daemon-measured duration but anchor it onto the client clock, so every start/end timestamp stays in one domain and remains comparable across tools. Live durations use the same projection, avoiding mixed-clock subtraction while still surviving transcript replay. Legacy and partial records without a usable daemon pair use the client-time pair. Consecutive thinking blocks merge regardless of which timing source produced them, accumulating each block's own duration.

## Compatibility

The existing compact-mode concept and persistence path remain unchanged. No new setting, URL parameter, public transcript prop, or `localStorage` key is introduced. The read-only `WebShellTranscript` remains outside compact mode.
