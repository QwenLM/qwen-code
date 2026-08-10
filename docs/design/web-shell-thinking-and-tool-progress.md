# Web Shell thinking visibility and tool progress

## Goal

Let users hide transcript thinking without changing model behavior, make parallel tool summaries describe every active foreground tool until all tools finish, and keep thinking/tool elapsed times stable across transcript replay.

## Design

`App` reuses the existing `Ctrl+O` shortcut for thinking visibility, removes the old Web Shell compact rendering path, and documents the new shortcut in Help. It initializes the preference from `localStorage`, defaults to showing thinking, and does not read or write the compact-mode workspace setting. `MessageList` removes thinking rows only from its rendered item list, leaving the transcript and model behavior unchanged.

Regular tool groups separated only by hidden thinking are merged within the same activity sequence. Visible thinking preserves the original interleaved transcript order. User, assistant, system, plan, approval, agent, todo, and question UI boundaries remain separate. Running tool summaries are derived from all active foreground tools and reuse the existing tool descriptions. Completed summaries remain unchanged and appear only after no tool is active. Expanded tool rows reuse the existing tool-kind icons.

Transcript blocks retain the first and latest daemon timestamps. Thinking and tool messages use that authoritative pair for completed durations only when it contains a positive elapsed interval. Live durations project the elapsed daemon duration onto the client clock, avoiding mixed-clock subtraction while still surviving transcript replay. Legacy and partial records without a usable daemon pair use the client-time pair.

## Compatibility

The default remains to show thinking. Missing, invalid, or unavailable `localStorage` falls back safely. No public prop, URL parameter, settings dependency, shortcut, or package dependency is added.
