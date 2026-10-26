# Copy Markdown from the assistant footer

[English](web-shell-copy-markdown.md) | [简体中文](web-shell-copy-markdown.zh-CN.md)

## Problem and scope

The assistant footer has a generic Copy button that already copies the original
Markdown. Users need two distinct entries: Copy content for the rendered plain
text and Copy Markdown for the complete original source. Preserve clipboard
fallback, streaming gates, and exported transcripts. The latest completed turn
keeps its footer actions visible.

## Solution and decisions

Add a Markdown M↓ icon immediately after Copy in `AssistantMessage.tsx`, with
its own `assistant.copyMarkdownSource` translation key so the footer label does
not collide with the selection menu's `assistant.copyMarkdown`. Label
the first action Copy content / 复制内容 with its own footer-specific translation
key. It extracts the entire rendered body through the text-only entry point of
the existing selection-copy serializer using a local Range, without changing
the user's selection. This
preserves paragraph/code line breaks, math source and image descriptions while
excluding controls and Markdown formatting. The second action copies the exact
original `content`. Both use the existing clipboard helper, including HTTP
fallback and failure reporting. Each button uses its own
`useCopiedFlash` state, so only the clicked button reports success. Reuse the
existing footer styling and a small inline SVG beside the existing footer icons;
no new primitive,
dependency, public option, or daemon route is needed.

## Validation and acceptance

Update `AssistantMessage.test.tsx` to check distinct rendered-text and exact
source-Markdown payloads, partial-selection preservation,
independent feedback, localization, timer cleanup, fallback, and visibility.
Add a focused browser test for adjacent buttons, real clipboard contents,
keyboard activation, and a screenshot using the existing mock daemon. This
validates UI and clipboard behavior, not a live model or Git backend.
Run build, typecheck, focused unit tests and browser E2E. Clipboard failures
must retain the current warning behavior without showing success. No open
questions remain.

## Latest turn visibility

Keep the built-in footer actions of the latest completed assistant turn visible
without hover. Compare its existing final-turn id to the latest turn that
produced a final assistant answer, pass the visibility flag through MessageItem
(including its memo comparison), and apply a local CSS class. Older turns retain hover/focus visibility; starting
a new user turn clears the previous footer's persistent visibility. Existing
streaming, background-work and document-mode gates remain authoritative. Verify
multiple turns, hover on older turns and transition to the next prompt in the
browser and focused MessageList tests.

## Footer tooltips and new-chat label

Use the shared Tooltip provider, trigger and content for all five icon actions
(Copy content, Copy Markdown source, satisfied, not satisfied and new chat). Remove native title
attributes, retain accessible names and route tooltip portals through the shared
Web Shell portal root. Reuse native button children so Radix refs remain valid
on React 18 and 19. The new-chat action uses the Lucide Split icon and is labeled
“New chat from here” / “从此处新建对话”; its request and pending behavior are
unchanged. Render Split at 13px with a 2.4 stroke and a clockwise 90-degree
rotation to match the neighboring icons. Verify keyboard focus, pointer hover, localization, portal placement
and the existing copy/branch interactions.

The timestamp retains hover/focus-only visibility even on the latest reply.
Touch devices keep the existing always-visible timestamp behavior.

TooltipContent accepts `variant="black"` for black background, white text and
a matching arrow. Omitting the variant preserves the existing theme-derived
colors. These five footer tooltips opt in; the override is local to the content
and does not change other tooltips or the host theme. Verify default/black ref
forwarding plus real browser text, background and arrow colors.

The black variant uses the same opaque dark gray for the body ring and arrow
outline, with a zero arrow offset. This keeps its edge visible in dark themes
and avoids a contrasting seam where the arrow meets the body. The default
variant retains its existing ring, outlined arrow and offsets.
Verify a high-DPI close-up as well as the functional color assertions.
