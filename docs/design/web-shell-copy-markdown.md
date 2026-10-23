# Copy Markdown from the assistant footer

[English](web-shell-copy-markdown.md) | [简体中文](web-shell-copy-markdown.zh-CN.md)

## Problem and scope

The assistant footer has a generic Copy button that already copies the original
Markdown. Users need an explicit Markdown entry beside it. Preserve existing
copy behavior, streaming gates, and exported transcripts. The latest completed
turn keeps its footer visible.

## Solution and decisions

Add a Markdown M↓ icon immediately after Copy in `AssistantMessage.tsx`, reusing
`assistant.copyMarkdown` for its localized title and accessible name. Both
buttons copy the complete `content` through the existing clipboard helper,
including its HTTP fallback and failure reporting. Each button uses its own
`useCopiedFlash` state, so only the clicked button reports success. Reuse the
existing footer styling and a small inline SVG beside the existing footer icons;
no new primitive,
dependency, public option, or daemon route is needed.

## Validation and acceptance

Update `AssistantMessage.test.tsx` to check exact Markdown preservation,
independent feedback, localization, timer cleanup, fallback, and visibility.
Add a focused browser test for adjacent buttons, real clipboard contents,
keyboard activation, and a screenshot using the existing mock daemon. This
validates UI and clipboard behavior, not a live model or Git backend.
Run build, typecheck, focused unit tests and browser E2E. Clipboard failures
must retain the current warning behavior without showing success. No open
questions remain.

## Latest turn visibility

Keep the complete built-in footer of the latest completed assistant turn visible
without hover. Compare its existing final-turn id to the latest turn-start id,
pass the visibility flag through MessageItem (including its memo comparison),
and apply a local CSS class. Older turns retain hover/focus visibility; starting
a new user turn clears the previous footer's persistent visibility. Existing
streaming, background-work and document-mode gates remain authoritative. Verify
multiple turns, hover on older turns and transition to the next prompt in the
browser and focused MessageList tests.
