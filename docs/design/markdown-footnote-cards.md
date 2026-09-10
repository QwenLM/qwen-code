# Markdown source footnote cards

[中文](./markdown-footnote-cards.zh-CN.md)

## Problem

Reports can cite several web pages, files, attachments, or private knowledge records for one claim. Standard GFM footnotes render those citations as separate numbers and a long footer, so readers must leave the claim to inspect each source. Private sources may also have stable locator fields without a durable URL.

## Decision

Use standard GFM footnotes whose identifier starts with `source-` as the portable source format. Web Shell groups adjacent source footnotes into a knowledge icon, previews one source per page, and shows the unique source count for the message. Other footnotes keep standard numbering, footer definitions, and return navigation.

The first link in a source definition is its title and open target. A normal HTTP(S) target opens normally. A host can instead encode stable provider fields in a fixed HTTPS sentinel and resolve it only after the user clicks. Web Shell does not understand provider fields or construct business URLs.

```markdown
Orders follow a shared business definition.[^source-1][^source-2]

This sentence has an ordinary explanatory note.[^note-1]

[^source-1]: [Order definition](https://example.com/orders) — Definition and scope.

[^source-2]: [Order policy](https://citation.invalid/dataworks-knowledge#v=1&kind=content&kbInstanceId=INSTANCE&sourceFileId=FILE&citationId=CITATION&relativePath=docs%2Forder.md&anchor=definition 'DataWorks Knowledge') — Relevant source excerpt.

[^note-1]: This remains a normal footnote.
```

## Rendering behavior

- Only resolved `source-*` definitions become source cards. Missing or malformed definitions fall back without removing answer text.
- Group adjacent source references, including intervening whitespace, within the same inline parent. Text, punctuation, ordinary footnotes, blocks, and table-cell boundaries stop a group.
- Deduplicate by definition ID in first-reference order. A single-source marker shows only the SVG; a multi-source marker also shows the unique count.
- Hover, focus, or click opens the card. Each definition is one page. Keyboard, touch, dismissal, boundary controls, streaming updates, themes, narrow viewports, and portal placement follow the existing Web Shell interaction rules.
- A linked definition uses the first safe link text as its title, the optional link title as its source label, and the remaining text as its summary. An unlinked definition uses its first strong text as the title. The first safe image remains an optional thumbnail.
- Remove a source definition only when every reference to it became a card. Keep definitions still targeted by a standard reference, ordinary footnotes, and their return links. Remove the footer container when none of those remain.
- Show a message-level `N sources` control derived only from unique source definitions referenced by that assistant message. It opens the same paginated preview over the complete message source set.
- Static document export keeps standard Markdown footnotes. Advanced-table text extraction retains the original reference numbers; the source Markdown remains unchanged.

## Host link integration

The source title inside the card uses the host's existing Markdown `components.a` renderer. Internal footnote references, ordinary definitions, and backreferences always use Web Shell's built-in anchor handling and never pass through the host renderer.

This lets an embedding host intercept a provider locator without adding a provider-specific Web Shell API:

```text
Footnote source link
→ host components.a
→ host validates and resolves the locator
→ host opens its own preview surface
```

The demo sentinel is `https://citation.invalid/dataworks-knowledge#...`. Provider fields live in the fragment so they are not sent over the network. The host must consume the complete `citation.invalid` namespace before its normal HTTP(S) branch, render the controlled action with `href="#"` or button semantics, and never expose the sentinel as a navigable DOM URL. Invalid versions, paths, duplicate or unknown fields, missing required fields, and oversized locators remain non-navigable.

The development demo uses one fixed valid fixture and only demonstrates link handoff and panel opening. Production locator validation and final URL construction belong to the embedding host.

The locator is untrusted Markdown. It cannot choose the BFF host, endpoint, credentials, or final URL. The host uses current session credentials and a fixed builder or authorized resolver. Until that resolver exists for a locator kind, the card remains readable and its open action stays disabled.

## Boundaries

- A footnote marker records what the final Markdown claims to cite; it does not prove that a tool returned the source or that the evidence entails the claim.
- One definition stores one locator. Reusing a source ID reuses the same location. Claims that require different anchors need different IDs or a future structured citation model.
- Session Sources remain an independent session reference directory. Their count is not the message citation count.
- No MCP server, Extension tool protocol, provider metadata store, or webpage metadata fetch is introduced.

## Validation

Unit tests cover source scoping, grouping, deduplication, source footer removal, ordinary footnote navigation, strong titles, host link interception, unsafe links, streaming, static export, and table copy. Browser tests replay a fixed report in development and production builds and cover SVG rendering, single- and multi-source markers, paginated cards, the message footer, keyboard/touch interaction, themes, narrow layouts, and portal isolation.

The host-specific URL builder is outside this PR. The Qwen demo proves that the complete sentinel reaches the host renderer. Unit and browser tests separately prove that ordinary footnote navigation remains isolated.
