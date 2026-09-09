# Markdown footnote cards

[中文](./markdown-footnote-cards.zh-CN.md)

## Problem

Web Shell parses GFM footnotes but renders adjacent references as separate
numbers. Readers must navigate to the footer to inspect each source. Provide a
compact knowledge icon with a source count and an interactive source preview.

## Behavior

- Apply to every shared Markdown surface, including assistant/thinking text and
  artifact previews. Static document export keeps standard footnotes.
- Group adjacent footnote references, including intervening whitespace, within
  the same inline parent. Text, punctuation, and block/cell boundaries stop a
  group. Deduplicate by definition ID in first-reference order.
- Show the supplied knowledge SVG and unique count. Hover opens after 150 ms;
  leaving both trigger and preview closes after 200 ms unless focus remains
  inside. Focus and click also open; Enter, Space, and ArrowDown move focus into
  the preview so Tab can reach pagination. Escape and outside clicks dismiss.
- Show one source per page with previous/next controls and an index/count.
  Disable boundary controls and omit pagination for a single source. Reopening
  starts on the first source; streaming updates retain a valid selected source.
- Derive the title and URL from the first safe link, the source label from its
  hostname, the summary from the remaining text, and the thumbnail from the first
  safe image. Plain notes use a localized footnote-number title. Missing/broken
  images take no space. Do not fetch webpage metadata or add a metadata API.
- Keep the complete footer and its return links. Return links focus and scroll
  to the corresponding group; separate Markdown instances have distinct IDs.

## Implementation

A rehype transform reads the existing GFM reference/footer nodes, attaches
internal preview data to grouped `sup` nodes, and namespaces footnote anchors.
Keep the original reference children available so advanced table text extraction
and host component overrides retain their original content. A custom host `sup`
renderer opts out of grouping. No public API changes are needed.

The default `sup` component renders a dedicated footnote card only for annotated
nodes; ordinary superscripts remain unchanged. Reuse the shared Popover and its
Web Shell portal integration, semantic theme colors, and existing external-link
opener. The local SVG is a trusted static mask rather than Markdown image input.
Card width is 360 px capped to the viewport with 12 px margins. The footer keeps
all original Markdown even when the compact preview truncates its summary.

No raw HTML is introduced. Validate extracted links and images through the
renderer URL policy before rendering. Footnote content is data, never instructions.
Preserve the existing large-stream plain-text threshold and memoized parsing.

## Validation

Cover AST grouping, ordering, deduplication, incomplete definitions, plain and
rich notes, footer navigation, instance isolation, host overrides, export mode,
and advanced table extraction in focused unit tests. Browser tests replay fixed
daemon messages to compare baseline and changed behavior, including streaming,
hover traversal, pagination, keyboard/touch input, themes, viewport collision,
portal isolation, and built SVG rendering. Keep E2E commands and evidence under
`.qwen/e2e-tests/markdown-footnote-cards.md`. Run build, bundle, typecheck, focused
tests, lint, self-audit, and review before submitting the PR.
