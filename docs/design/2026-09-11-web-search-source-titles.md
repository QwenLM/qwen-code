# Web search source titles

[English](2026-09-11-web-search-source-titles.md) | [简体中文](2026-09-11-web-search-source-titles.zh-CN.md)

Status: implemented by the PR that adds this document. Design discussion: #11564.

## Problem and scope

The built-in `web_search` tool tells the model to end its answer with a `Sources:` section of markdown links, and its example shows `[title](url)`. The tool result the model receives lists bare URLs, because DashScope's `web_search_call` items carry `{type, url}` and nothing else. The model either invents a title or pastes a raw link into the answer.

This design gives cited pages real titles. It covers where titles come from, how they are matched to pages, how they are rendered into the tool result, and what the model is told. It does not change the search request budget, add other providers' search backends, or add per-result summaries.

## Current state

The DashScope backend (`packages/core/src/tools/web-search-dashscope.ts`) collects the search agent's narration, the pages the extractor opened, and the pages search returned. The tool (`packages/core/src/tools/web-search.ts`) renders the narration followed by an opened-pages section and a candidates section, each listing `- <url>`, then appends a citation policy and a safety footer.

A first implementation in #11490 read titles from a list the side model wrote and then edited the narration around that list: it stripped the block, retained lines for pages the evidence sections would omit, restored the heading, and fell back to extracted text when stripping emptied the answer. It worked end to end, but review grew from 16 findings to 29, almost all on the editing machinery, so the feature was split out to #11564.

## Goals

- A page with a usable title is listed as `[title](url)` in the tool result; any other page stays a bare URL.
- A parsing mistake can cost or mislabel a title but never rewrites the narration.
- A title can only be attached to a page the search returned or the agent opened.
- Without titles, the page lists match the previous output apart from de-duplicating pages by identity; the citation policy wording changes for every result.
- Link text renders correctly in the CLI.

## Design

### Where titles come from

Titles have two sources. The first, relayed titles, come from the side model: its instructions ask it to begin its reply with a line containing only `Sources:`, followed directly by one `- <page title> — <url>` line per page it relied on with no blank lines inside the list, listing only URLs from its results or pages it opened, then a blank line and the answer. The list goes first because the side request runs under a fixed 60s budget and a stream cut short is salvaged from whatever already arrived.

The second, declared titles, are titles the search response itself carries on `action.sources[].title`; none has been observed so far. When both exist for a URL, the relayed title wins, because the agent read the page while the search index only listed it.

Relayed titles are read only from what the side model wrote — its narration or streamed text. Salvaged extractor output is never read for titles, because a page could author its own citation there.

Structured output was considered and is not available: with `web_search` enabled, DashScope's Responses API ignores `text.format` `json_schema` and `json_object` (probed 2026-09-11; HTTP 200, the search runs, the reply is plain markdown). Asking for a JSON-only reply in the prompt would make a reply cut off by the budget unparseable as a whole.

### Reading the list

`readSideModelTitles(narration, knownKeys)` returns relayed titles and never modifies the narration. The narration reaches the model with its content unedited, including the agent's own list. Only the list the instructions ask for is read:

1. The header must be the first non-blank line of the reply: at most 32 characters once trimmed, matching `Sources:` with optional heading marks, bold markers and colon. A list anywhere else — after the answer, or inside a code fence — is never read, so fence tracking is not needed.
2. Blank lines may separate the header from the first entry. After the first entry, a blank line ends the list, as does any line that is not an entry, so the answer that follows is never read.
3. An entry is a line that starts with a list marker (`-`, `*`, `+`, `•`, `‣`, `1.`, `1)`) and carries exactly one `http(s)` URL; the title is the rest of the line, on either side of the URL. A line without a marker, or with more than one URL, is not an entry.
4. Brackets hugging the URL (`(url)`, `<url>`, `[url]`), brackets around the whole entry and a markdown link's label (`[title](url)`, where text after the link is commentary) are taken apart. Trailing punctuation and closing brackets the URL never opened are dropped from the URL.
5. An entry whose URL is not among the pages the search returned or the agent opened is ignored, and an entry without a title still continues the list.
6. Titles from either source are cleaned: whitespace collapsed; leading and trailing separators (space, tab, `—`, `–`, `-`, `:`, `|`, `·`, `•`) and wrapping emphasis, quotes and brackets stripped; a title that is only emphasis markers is empty; at most 200 UTF-16 code units, cut on a character boundary. An empty title contributes nothing.
7. Titles are keyed by page identity plus the URL's fragment, and the first title for a key wins. A title given for a URL with a fragment labels only that section; a title given without a fragment labels any section of the page.
8. Lines longer than 2,000 characters are never entries. The header pattern is the only one that can backtrack and it only sees lines of at most 32 characters; every other step is a single linear pass over one line, so reading the list costs time linear in its length whatever page text shaped it.

### Page identity

`sourceKey(url)` in `packages/core/src/tools/web-search-backend.ts` is the single identity used for matching titles to pages and de-duplicating pages. For `http(s)` URLs, the scheme, host case, a trailing slash, percent-encoding of ordinary path characters and the fragment do not distinguish pages; a non-default port, the query string, and an encoded `/`, `?`, `#` or `%` in the path do, because decoding those would move the path/query boundary or merge distinct path segments. Other schemes keep their scheme, and text that does not parse as a URL gets its own namespace.

Each tier is de-duplicated by identity, keeping the first spelling. Opened pages come first; a candidate that is the same page as a listed opened page is not listed again, while one whose opened spelling fell past the 25-page cap is still listed as a candidate, so no page disappears from both lists.

### Rendering

`renderSource` lists `- [text](url)` only when all of these hold, and `- url` otherwise:

- A title exists and, after sanitizing, is non-empty and not the URL itself. Sanitizing replaces `[` and `]` with `(` and `)` and drops backslashes and backticks, because the CLI never unescapes link text and ends it at the first `]`.
- The URL parses as `http(s)` with a host, contains no whitespace, and has at most one level of balanced parentheses, matching the CLI's inline-link pattern (`MD_LINK_CAPTURE` in `packages/cli/src/ui/utils/osc8.ts`). URLs are never re-encoded.
- The title does not read as a different destination. The title is NFKC-folded (so lookalike dots and full-width forms read as ASCII); if it contains `://` it is rejected. If it has no whitespace and carries a host marker (a dot, colon or bracket), it is parsed as an authority the way a browser parses an address typed without a scheme, after normalizing bracketed or parenthesized IPv6 authorities. If that yields a host, the host must be the page's own host or a parent domain of it (a leading `www.` is ignored), and when the title has a path, the path must be the page's own path.

There is no domain-name fallback for untitled pages.

### What the model is told

The citation policy asks for markdown links using a title shown in the two page lists (the opened evidence pages and the additional search candidates), says that a title appearing only in the narrated answer is not verified, and asks for such a page — and any page listed without a title — to be cited by its bare URL, never with an invented title or URL. The tool description says each source page is listed with a title when a usable one was available, and that the narration's own `Sources:` list is not the authoritative page list.

## Decisions and rationale

| Decision                        | Choice                                                                                                                  | Rationale                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Edit the narration or read only | Read only                                                                                                               | Every finding on the editing mechanism disappears with it; a parsing error costs or mislabels a title instead of altering the narration. The cost is that pages named in the agent's list appear in both the narration and the page lists. |
| Which text is parsed            | Only the list that opens the reply, ending at a blank line or non-entry; entries need a list marker and exactly one URL | Everything outside the requested list — answer prose, quoted page text, code fences — cannot be harvested, and the grammar needs no fence or prose heuristics.                                                                             |
| Title source                    | Relayed list, then response-declared title, else none                                                                   | Search items have carried no titles so far; structured output is ignored by the endpoint.                                                                                                                                                  |
| URL identity                    | One `sourceKey` everywhere; titles additionally keyed by fragment                                                       | Mixing exact and normalized keys caused mismatched titles and duplicate or collapsed pages in the first implementation; a section's title must not label another section.                                                                  |
| Rendering                       | Sanitize for the CLI renderer; reject titles that parse as another destination; no domain fallback                      | See the note below.                                                                                                                                                                                                                        |
| List position                   | Before the answer                                                                                                       | A reply cut off by the budget keeps the titles that already streamed.                                                                                                                                                                      |

The CLI's `labelMayDeceive` check is deliberately not mirrored. In the CLI it is intentionally permissive because a false positive only keeps the `(url)` suffix visible when the reply is rendered. At the tool layer the same false positive would discard the title, and the check rejects ordinary titles such as `Node.js Releases` (`node.js` reads as a host) or `Qwen3.6-Plus: Towards Real World Agents` (reads as a scheme) — about half of the titles observed in live runs. Instead the tool parses a title the way a browser would: prose with whitespace is kept, and anything that parses as a URL, host, address or host with a path must match the page. Two consequences are accepted: a single dotted token that happens to parse as another host (a page titled just `Node.js`) falls back to a bare URL, and a dotless integer address (`2130706433`) is kept because it does not read as an address. Other front ends that render link labels without a destination check (such as web-shell's markdown links) treat these tool-provided titles like any other model-written link text.

## Constraints and risks

- The side request's reply format changes with its instructions. A reply that ignores the format yields bare URLs with the narration intact; a reply whose list names a page with a description instead of its title yields that description as the link text.
- A page the agent names appears twice in the tool result, once in the narration and once in the page lists.
- Titles take space in the 100,000-character result. Under size pressure the narration is truncated first, so titled page lists leave less of the narration than untitled ones would.
- The 60s side-request budget is unchanged. Measured side-request latency is 13–107s, so some searches still end in the partial-result path, where titles survive only if the list had already streamed.

## Validation

- Unit tests for `sourceKey` (scheme, case, slash, fragment, query, default and non-default ports, encoded parentheses and delimiters, undecodable paths, other schemes, unparseable input) and for each reading rule, including code fences, answer prose, URL-first and wrapped entries, surrogate-safe truncation, an over-long header, and a 1,000-entry list inside the length gates read in linear time.
- Tool-level tests for titled rendering with the narration unchanged, dropping unreturned URLs, response titles and precedence, no titles from extractor text, titles from streamed text, de-duplication across tiers and spellings including the opened-page cap, section-scoped titles, link-text sanitizing, destination-reading titles (URLs, hosts, IP forms, lookalike characters, same-host paths) and the titles kept beside them, unusable link targets, parenthesized URLs, the scoped citation policy, the pinned entry format, and truncation keeping titled sources.
- Deliberate regressions were checked to turn these tests red.
- Live runs against a Token Plan endpoint with `qwen3.8-flash`, parsing real replies with this reader: across 7 replies to 5 queries, 6 opened with `Sources:` on its own line, and in those 6 the titles attached against URLs anywhere in the reply were 6/6 and 5/5 on two Node.js runs, 8/10 on TypeScript, 5/5 on Rust, 4/4 on Mercury and 3/3 on Python. One Node.js reply put its first entry on the `Sources:` line; that list was not read and its pages fell back to bare URLs. End-to-end runs showed titled links in the tool result and in the model's final `Sources:` section.

## Acceptance criteria

- The narration's content in the tool result is exactly the side model's text; it is only trimmed and, above the result limit, truncated with a note.
- Only URLs the search returned or the agent opened receive titles; relayed titles never come from extractor output, and only the list that opens the reply is read.
- Without titles, the page lists match the previous output apart from page de-duplication.
- All page comparisons go through `sourceKey`; a title labels a section only if it was given for that section or for the whole page.
- Rendered links fit the CLI's inline-link pattern; titles that read as another destination fall back to bare URLs.

## Follow-up

- Make the side-request budget configurable and revisit its default (separate change).
- Per-result summaries, when a backend that returns them is added.
