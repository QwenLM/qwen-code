# Web Shell context ring opens the details panel

[English](2026-10-13-web-shell-context-ring-details.md) | [简体中文](2026-10-13-web-shell-context-ring-details.zh-CN.md)

## Problem and scope

Clicking the composer context ring posted a `Context Usage` snapshot card into the transcript, and that card's own detail action posted a second one. Checking usage a few times during a long session left several near-identical cards interleaved with the conversation, each frozen at a different moment, and each click pulled the transcript back to the tail even while the user was scrolled up. Issue #14051.

Hover already shows the summary, so the click was repeating it somewhere else instead of going one level deeper.

## Design

Reuse the one details surface that already exists: the right panel's context usage tab. Its id is `context-usage:${sessionId}` and its opener replaces a matching tab instead of appending, so repeated clicks cannot stack. It already renders the per-category breakdown with expandable items, refresh, compression, and load and error states.

The change is therefore a rebinding, not a new surface:

- The ring click opens that panel instead of posting a card.
- A transcript context card's detail action opens the same panel instead of posting a second card.
- Hover is unchanged, and the popover keeps its own detail action, because keyboard and touch have no hover.
- Typing `/context` or `/context detail` still prints into the transcript: the user asked for it there explicitly.

An anchored popover or dialog was rejected. A full breakdown in a toolbar-anchored popover needs collision, scroll, and focus-trap work, and a dialog has to go through the portal root; either way the app would carry two details surfaces for the same data unless the panel were removed as well.

### Fallback

A composer whose host offers no details surface keeps the snapshot. Today that is only the embedded side-task pane, which already lives inside the right panel and has nowhere to open a tab. Its ring still posts `/context` into its own conversation, and only that case shows the hover hint saying so, because the old copy would otherwise be false. The main composer always has a panel, so its snapshot wiring was removed rather than left unreachable.

## Known limitation

Reopening an already-open panel does not refetch. The panel is a persistent surface with its own refresh control, like a file preview: clicking its opener again focuses it rather than reloading it. A follow-up could refresh on reopen, or toggle the panel closed.

## Files and validation

`client/components/ChatEditor.tsx`, `client/App.tsx`, their unit tests, and the two browser specs that asserted the old card stacking. The package README and the context usage callback design doc change in both languages, because the host callback now also receives ring clicks and card detail clicks.

Verify: hover summary unchanged; a click opens one panel tab and a second click keeps it at one; no click adds a transcript card; `/context` and `/context detail` still print cards; a card's detail action opens the panel; the embedded side-task ring still posts a snapshot and still shows the hint; a split pane opens its own session's tab. Run build, typecheck, lint, the web-shell unit tests, and the two context browser specs.

## Acceptance and risks

Checking context usage no longer writes to the conversation, and every entry point reaches one details surface. Risks: a host that relied on a ring click producing a transcript card now gets the panel or its own callback; the embedded pane keeps the old behavior on purpose. No daemon routes or data contracts change.
