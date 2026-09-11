# Generic Markdown footnote cards and host icons

[中文](./markdown-footnote-cards.zh-CN.md)

## Problem and decision

Reports cite web pages, files, attachments, knowledge records, and explanatory notes. All resolved Markdown footnotes use the same aggregation mechanism, regardless of ID or content. Numeric, named, Chinese, linked and plain-text notes are supported. The existing knowledge icon remains the default. Hosts can independently select an image resource for each inline group and the Assistant action footer without supplying React components.

```markdown
Orders follow a shared definition.[^a][^b]

Resource group specifications affect concurrency.[^c]

[^a]: [Order definition](https://example.com/orders 'Knowledge') — Business definition.

[^b]: An explanation without a link.

    More detail, preserved in the original definition.

[^c]: [Resource specifications](https://example.com/resources) — Specification details.
```

## Public contract

`WebShellMarkdownCustomization` exposes two optional synchronous, side-effect-free functions: `getInlineFootnoteIcon` and `getAssistantFootnoteIcon`. Both use the exported `WebShellFootnoteIconResolver` type and return the existing `WebShellIconSource` resource URL, or null/undefined for the default. The host needs no React dependency to write these functions.

Each function receives a readonly list of `WebShellFootnote` values:

| Field                        | Meaning                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id: string`                 | Logical footnote ID as written in its definition, without the message DOM prefix or URL encoding.                                                                   |
| `number: number`             | Footnote number in first-reference order.                                                                                                                           |
| `definitionMarkdown: string` | Complete definition, including `[^id]:`, multiline content and original URLs. Read directly from the AST source position in the Markdown after `transformMarkdown`. |
| `title?: string`             | Text of the first safe link.                                                                                                                                        |
| `summary: string`            | Remaining textual content; the whole note for an unlinked definition.                                                                                               |
| `href?: string`              | First safe link target, using the existing Markdown URL transformation.                                                                                             |
| `source?: string`            | The first safe link's optional title attribute.                                                                                                                     |
| `image?: string`             | First safe thumbnail URL.                                                                                                                                           |

No HAST, DOM or React objects enter the public list. The example produces inline calls with `[a,b]` and `[c]`, and an Assistant call with `[a,b,c]`. Each list is deduplicated by ID in first-reference order; distinct IDs sharing a URL remain distinct. Pagination selects content within the group without changing the resolver input. React may render more than once; total callback invocation counts are not guaranteed.

```ts
const markdown = {
  getInlineFootnoteIcon: (notes) =>
    notes.every((note) => note.href?.startsWith('https://citation.invalid/'))
      ? '/icons/knowledge.svg'
      : '/icons/web.svg',
  getAssistantFootnoteIcon: () => '/icons/references.svg',
};
```

The callbacks are independent. Missing callbacks, empty/null results, invalid URLs and thrown exceptions fall back to the default knowledge icon. Custom assets use the composer's monochrome mask and image URL policy (including rejection of SVG data URLs). Inline icons are 16px; footer icons are 14px. Only the default footer knowledge glyph receives the existing 1px optical lift. The host controls only the icon; Qwen owns counts, buttons, hover, keyboard, pagination and links. Host assets must normalize their own viewBox padding, painted size, optical center and stroke weight: equal CSS boxes alone do not imply matching glyphs. The demo footer resource is sized against the Assistant copy glyph; browser acceptance checks painted bounds and visual centroids as well as element geometry.

## Rendering and lifecycle

- Adjacent references, allowing whitespace, form one group within their inline parent. Text, punctuation, block and table-cell boundaries break groups. A single reference also forms a group.
- Pure-text notes have a localized “Footnote n” title, the full explanation and no navigation. Long descriptions are scrollable, including with the keyboard.
- Hover, focus and click open the preview. Paging or clicking the trigger pins it until Escape or an outside click. Hover-only previews close after leaving. A page represents one definition.
- The Assistant footer shows “N citations” beside copy, branch and time, using the message's unique referenced definitions. It follows existing message hover/focus and touch visibility rules. Standalone Markdown keeps its aggregate footer fallback.
- Unresolved definitions keep literal references. A definition is removed from the ordinary footer only when every occurrence was converted. References that cannot be converted (for example inside a link) retain their ordinary target and return navigation.
- Definition extraction shares the existing AST pipeline; it does not reparse Markdown. Existing stable source reporting and component identities preserve open cards through streaming updates. Message instances keep isolated DOM anchor namespaces.
- Markdown copy and static document export preserve standard footnotes. Custom `components.sup` continues to opt out of aggregation. Advanced-table copy keeps original reference text.

## Current-page content slot

`mountFootnotePreview(container, info)` optionally replaces only the current page's source label, title, description and thumbnail. Qwen retains grouping, trigger icons/counts, popup placement, hover/pin/Escape behavior, keyboard navigation and the pager. The same slot serves inline and Assistant-footer previews. Omitting it, declining with null/undefined, or synchronously failing restores the default page.

The framework-neutral mount function receives a connected, visible HTML container and `WebShellFootnotePreviewInfo`: the complete readonly `footnotes` list, current `footnote`, zero-based `index`, `location` (`inline` or `assistant`), localized `title`, resolved `sourceLabel`, and `sourceLink` (a Qwen-owned HTMLElement). Metadata remains plain data without AST/React objects. The DOM element is a presentation handle: place it in the custom layout without replacing its children. Qwen renders the current source link into it through the existing `components.a` path, including host interception and ordinary safe-link behavior. Unlinked notes expose a non-navigable title.

Return a `WebShellFootnotePreviewHandle` with synchronous `update(info)` and `dispose()` methods. Mount runs when the popup opens. Paging and streamed data invoke update without recreating the host view. Closing/unmounting, replacing the mount function or falling back disposes the view. React StrictMode may mount/dispose more than once; each successful mount has one matching cleanup. Hosts should keep the mount function stable, handle their own asynchronous errors, and clean up resources if mounting throws before a handle is returned. Synchronous mount/update/cleanup errors are isolated from the report; changing page/data or the mount function can retry a failed page.

Custom content stays in the shell portal and a bounded scroll region. DOM/SolidJS implementations need no React element factory. A host that mounts Solid must retain its reactive owner as required by Solid and return its update/dispose operations. This slot neither changes `components.sup` opt-out priority nor runs for static document footnotes.

The demo offers default and custom content modes; custom content uses a plain DOM mount, places the Qwen-managed source link in its layout and updates on the built-in pager. Unit and browser checks cover payload isolation, current-page/list consistency, mount/update/dispose, fallback/recovery, preserved link interception, focus/paging, streaming and static export.

A minimal DOM host can use the slot as follows:

```js
const markdown = {
  mountFootnotePreview(container, initial) {
    const summary = container.ownerDocument.createElement('p');
    const update = (info) => {
      summary.textContent = info.footnote.summary;
      container.replaceChildren(info.sourceLink, summary);
    };
    update(initial);
    return {
      update,
      dispose() {
        container.replaceChildren();
      },
    };
  },
};
```

## Host links and scope

Card titles use the existing host `components.a` renderer. Internal reference/backreference navigation stays built in. A normal HTTP(S) link opens normally. A host may encode private locator fields in a sentinel such as `https://citation.invalid/dataworks-knowledge#...`, validate and resolve it on click, and open its own panel. Web Shell neither interprets these fields nor builds OpenCode business URLs. Without a host resolver, the sentinel remains non-navigable. The demo uses fixed fixtures, ordinary IDs, two different inline asset icons, an independent footer asset and an illustrative host panel.

Aggregation is not limited to sentinel links or any business source format. A footnote records what the report cites, not proof of retrieval or entailment. Session Sources remain a separate session directory. This change adds no MCP, Core citation protocol, metadata fetches or provider-specific resolver.

## Implementation and verification

Changes are limited to Web Shell customization types/exports, the existing Markdown AST transform, footnote cards, Assistant footer wiring, demo and tests. There are no open design questions.

Focused tests verify IDs, multiline original text after transforms, safe parsed fields, exact group/message lists, same-URL distinct notes, callback independence/fallback, default/custom sizing, streaming, incomplete definitions, partial conversion, host links, copy and static export. Development and production browser E2E cover grouping, scrollable descriptions, paging persistence, message hover, keyboard/touch, themes, viewport/portal boundaries and cross-message isolation. The development demo additionally verifies custom SVG assets and host panel handoff; production acceptance uses the built app. Build and typecheck must pass.
