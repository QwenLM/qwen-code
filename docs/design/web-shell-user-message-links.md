# Clickable URLs in Web Shell User Messages

[English](web-shell-user-message-links.md) | [简体中文](web-shell-user-message-links.zh-CN.md)

## Problem statement

In the Web Shell conversation history, assistant messages already render bare
URLs as clickable links (remark-gfm autolink literals → `MarkdownLink`), but
user messages render as raw plain text. A URL the user typed or pasted into
the composer is not clickable in the transcript, forcing copy-paste to open it.

## Current state

- `packages/web-shell/client/components/messages/UserMessage.tsx` renders user
  text without any link detection:
  - `DefaultUserMessageContent` renders annotated text segments as raw
    `{segment.text}`.
  - The `renderedContent` memo's parsed-parts path returns `part.text` raw
    (and returns the whole `content` string when parsing fails).
- Assistant output goes through `Markdown.tsx`; `MarkdownLink`
  (`Markdown.tsx:765`) validates hrefs with `isSafeHref` (`Markdown.tsx:167`)
  and routes clicks through `useExternalLinkOpener`
  (`client/hooks/useExternalLinkOpener.ts`), which intercepts navigation in
  the packaged desktop shell and is a no-op in plain browsers (native
  `target="_blank"` applies).

## Proposed changes

1. **New util `client/utils/linkify.ts`** exporting
   `splitTextByUrls(text): Array<{ type: 'text' | 'url'; value: string }>`:
   - Matches `http://` and `https://` URLs only (explicit scheme required).
   - The character set is an allowlist of the ASCII URL grammar
     (RFC 3986-ish); anything outside it — whitespace, markup delimiters, CJK
     prose, emoji — terminates the match. Non-ASCII characters are
     percent-encoded in real URLs, so they fail closed to plain text.
   - Trims trailing ASCII sentence punctuation (`, . ; : ! ? '`),
     markdown emphasis delimiters (`*`, `_`, `~`), and closing brackets `)`,
     `]`, `}` with no matching opener inside the URL (a `)` is kept when the
     URL contains a matching `(` — e.g. Wikipedia-style URLs).
   - A match that trims down to the bare scheme (`https://`) is not a URL and
     stays text.
2. **New component `client/components/messages/LinkifiedText.tsx`**: renders a
   string with URL segments as `<a target="_blank" rel="noopener noreferrer">`,
   validated by `isSafeHref` and clicked through `useExternalLinkOpener`,
   mirroring `MarkdownLink`. Non-URL segments render as-is. When the text
   contains no URL it returns the plain string (no extra DOM nodes). The
   href percent-normalizes a bare `%` (not followed by two hex digits →
   `%25`) to match the assistant markdown path; the visible text stays
   verbatim.
3. **`UserMessage.tsx`**: wrap text segments with `LinkifiedText` in both
   default rendering paths (`DefaultUserMessageContent` text segments and the
   parsed-parts text parts in the `renderedContent` memo), plus the
   scheduled-task-run prompt.
4. **Link styling**: `LinkifiedText` reuses the `.link` rule from
   `Markdown.module.css` — no copy.

## Design decisions and rationale

| Decision                                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit `https?://` scheme only; no bare `www.`/domains/emails                | Minimum surface, near-zero false positives; pasted URLs almost always carry a scheme.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ASCII allowlist, not a denylist of prose characters                            | A denylist is wrong in both directions: unlisted scripts (emoji, Thai) get absorbed into the href, and excluded ASCII quotes truncate URLs containing them (`/wiki/L'Aquila`). The allowlist fails closed to plain text; its boundary behavior is inspired by remark-gfm (which assistant messages use) but not identical to it — known deltas: no left boundary is required before an ASCII alphanumeric (`xhttps://…` still links), a trailing HTML character reference is not resolved (`…/page&amp;` keeps `&amp`), the tokenizer is stricter than GFM on a trailing backtick and backslash (they terminate the match), and a balanced `a[0]` keeps its `]`. |
| Raw IRIs are not linkified whole                                               | `https://zh.wikipedia.org/wiki/中文` linkifies only its ASCII prefix. Accepted tradeoff: absorbing CJK would swallow the following prose (`详情见https://example.com即可使用`); percent-encoded URLs are unaffected. Measured wrong-link shapes beyond this: markdown link syntax pasted as plain text (`[https://a.example](https://b.example)`) yields an unusable href, and a bare `%` reaches the wire unnormalized on the assistant path's terms — so `LinkifiedText` normalizes the href (`%` not followed by two hex digits → `%25`, e.g. `/100%` → `/100%25`) while keeping the visible text verbatim.                                                   |
| Reuse `isSafeHref` + `useExternalLinkOpener`                                   | Same safety check and desktop-shell routing as assistant-message links; no second policy to maintain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Separate tiny util + component instead of routing user text through `Markdown` | User text is intentionally not markdown (composer tags, `white-space: pre-wrap` layout); a regex tokenizer avoids changing that contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| No linkification inside host-provided `renderUserMessageContent` output        | That output belongs to the embedding host; overriding it would break the customization contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Scheduled-task-run prompt is linkified too                                     | Only the header lines are machine-generated; the prompt body is user-authored task instructions, so it gets the same treatment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Files affected

- `packages/web-shell/client/utils/linkify.ts` (new)
- `packages/web-shell/client/utils/linkify.test.ts` (new)
- `packages/web-shell/client/components/messages/LinkifiedText.tsx` (new)
- `packages/web-shell/client/components/messages/LinkifiedText.test.tsx` (new)
- `packages/web-shell/client/components/messages/UserMessage.tsx` (wrap text)
- `packages/web-shell/client/components/messages/UserMessage.test.tsx` (integration case)
- `packages/web-shell/client/e2e/web-shell.user-message-links.spec.ts` (new, `@smoke`)

## Scope boundaries

- User messages in the Web Shell transcript only (this also covers the
  `mid_turn_message_injected` system messages that reuse `UserMessage`).
- No changes to assistant/thinking/markdown rendering, the composer input
  field, or the CLI terminal UI.

## Validation

- Unit tests for `splitTextByUrls`: scheme filtering, trailing punctuation and
  markdown emphasis delimiters, balanced/unbalanced brackets, CJK / emoji /
  Thai termination, apostrophes inside URLs, multiple URLs, bare-scheme and
  no-match passthrough.
- Component tests for `LinkifiedText` and `UserMessage` integration cases
  (every render path: default, annotated segments, host-parser parts,
  parse-failure fallback, scheduled-task prompt): URL renders as an anchor
  with `target="_blank"` / `rel="noopener noreferrer"`; surrounding text and
  composer-tag chips unchanged; desktop-shell clicks route through
  `useExternalLinkOpener`.
- Playwright `@smoke` spec replaying a user message with a URL through the
  mock daemon.
- `npm run build && npm run typecheck` and focused vitest runs.

## Acceptance criteria

- A user message containing `https://example.com/foo` shows it as a link that
  opens in a new tab (browser) or the system browser (desktop shell).
- Trailing punctuation such as `https://example.com/foo.` links without the
  final `.`.
- Messages without URLs render exactly as before.

## Open questions

- None.
