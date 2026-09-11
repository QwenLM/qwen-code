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

- A page the search agent named is listed as `[title](url)` in the tool result; any other page stays a bare URL.
- A parsing mistake can cost a title but never change the evidence the model reads.
- A title can only be attached to a page the search returned or the agent opened.
- A result without titles is byte-identical to the previous output.
- Link text renders correctly in the CLI.

## Design

### Where titles come from

The side request's instructions ask the search agent to begin its reply with a line containing only `Sources:`, followed by one `- <page title> — <url>` line per page it relied on, listing only URLs from its results or pages it opened, then a blank line and the answer. The list goes first because the side request runs under a fixed 60s budget and a stream cut short is salvaged from whatever already arrived.

A title carried by the search response itself (`action.sources[].title`) is also read; none has been observed so far. When both exist, the side model's title wins, because the agent read the page while the search index only listed it.

Titles are read only from what the side model wrote — its narration or streamed text. Salvaged extractor output is never read for titles, because a page could author its own citation there.

Structured output was considered and is not available: with `web_search` enabled, DashScope's Responses API ignores `text.format` `json_schema` and `json_object` (probed 2026-09-11; HTTP 200, the search runs, the reply is plain markdown). Asking for a JSON-only reply in the prompt would make a reply cut off by the budget unparseable as a whole.

### Read-only extraction

`readSideModelTitles(narration, knownKeys)` returns titles keyed by page identity and never modifies the narration. The narration reaches the model exactly as written, including the agent's own list. Rules:

1. Lines inside code fences (` ``` ` or `~~~`) are skipped.
2. A list starts at a line that, trimmed, is at most 32 characters and matches `Sources:` with optional heading marks, bold markers and colon. `Sources:` mid-sentence does not start a list.
3. Inside a list, blank lines are skipped; a line that parses as an entry continues the list; the first other line ends it. Every list in the narration is read.
4. An entry is `[title](url)`, or `title <separator> url` with the URL at the end of the line (separators `—`, `–`, `-`, `:`, `|`). A bullet (`-`, `*`, `+`, `•`, `‣`, `1.`, `1)`) is optional; without one, the line must be a bare URL or have a separator before the URL. An entry with a URL but no title continues the list without contributing a title. Unbalanced trailing `)` or `]` is trimmed from the URL.
5. An entry whose URL is not among the pages the search returned or the agent opened is ignored.
6. Titles are cleaned: whitespace collapsed; leading and trailing separators, wrapping `**`/`__` and quotes stripped; a title that is only emphasis markers is empty; at most 200 characters. An empty title contributes nothing.
7. The first title for a page wins.
8. Lines longer than 2,000 characters are never entries, and header matching only sees lines of at most 32 characters, so the patterns that can backtrack never see adversarial-length input. The code-fence check is linear and runs on every line.

### Page identity

`sourceKey(url)` in `packages/core/src/tools/web-search-backend.ts` is the single identity used for matching titles, looking them up and de-duplicating pages. Scheme, host case, trailing slashes, percent-encoding in the path and the fragment do not distinguish pages; the port and the query string do. A URL that does not parse falls back to its trimmed, lower-cased text. Opened pages come first; a candidate whose key matches an opened page is not listed again; the first spelling of a page is the one rendered.

### Rendering

`renderSource` lists `- [text](url)` only when all of these hold, and `- url` otherwise:

- A title exists and, after sanitizing, is non-empty and not the URL itself. Sanitizing replaces `[` and `]` with `(` and `)` and drops backslashes and backticks, because the CLI never unescapes link text and ends it at the first `]`.
- The URL is `http(s)`, contains no whitespace, and has at most one level of balanced parentheses, matching the CLI's inline-link pattern (`MD_LINK_CAPTURE` in `packages/cli/src/ui/utils/osc8.ts`). URLs are never re-encoded.
- The title does not name a different destination: it contains no `scheme://`, and it is not solely a host or IPv4 address other than the page's own host (a leading `www.` is ignored, and a parent domain of the page's host is allowed).

There is no domain-name fallback for untitled pages.

### What the model is told

The citation policy asks for markdown links using the title shown for a page, a bare URL for an untitled page, and never an invented title or URL. The tool description says the result lists source pages titled when the agent named them, and that the narration's own `Sources:` list is not the authoritative page list.

## Decisions and rationale

| Decision                        | Choice                                                                                           | Rationale                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit the narration or read only | Read only                                                                                        | Every finding on the editing mechanism disappears with it; a parsing error degrades to a missing title instead of altered evidence. The cost is that pages named in the agent's list appear in both the narration and the evidence sections. |
| Title source                    | Side-model list, then response title, else none                                                  | Search items carry no titles; structured output is ignored by the endpoint.                                                                                                                                                                  |
| URL identity                    | One `sourceKey` everywhere                                                                       | Mixing exact and normalized keys caused mismatched titles and duplicate or collapsed pages in the first implementation.                                                                                                                      |
| Rendering                       | Sanitize for the CLI renderer; reject only titles naming another destination; no domain fallback | See the note below.                                                                                                                                                                                                                          |
| List position                   | Before the answer                                                                                | A reply cut off by the budget keeps the titles that already streamed.                                                                                                                                                                        |

The CLI's `labelMayDeceive` check is deliberately not mirrored. In the CLI it is intentionally permissive because a false positive only keeps the `(url)` suffix visible when the reply is rendered. At the tool layer the same false positive would discard the title, and the check rejects ordinary titles such as `Node.js Releases` (`node.js` reads as a host) or `Qwen3.6-Plus: Towards Real World Agents` (reads as a scheme) — about half of the titles observed in live runs. The tool rejects only the two spoof shapes above; the CLI's own check still applies to the model's rendered reply.

## Constraints and risks

- The side request's reply format changes with its instructions. Every failure mode degrades to the previous output: bare URLs, narration intact.
- A page the agent names appears twice in the tool result, once in the narration and once in the evidence sections.
- The 60s side-request budget is unchanged. Measured side-request latency is 13–107s, so some searches still end in the partial-result path, where titles survive only if the list had already streamed.

## Validation

- Unit tests for `sourceKey` (scheme, case, slash, fragment, query, port, encoded parentheses, undecodable paths, unparseable input) and for each extraction rule, including adversarial-length lines.
- Tool-level tests for titled rendering with the narration unchanged, dropping unreturned URLs, response titles and precedence, no titles from extractor text, de-duplication across tiers and spellings, link-text sanitizing, destination-naming titles, parenthesized URLs, and truncation keeping titled sources.
- The existing execute tests pass unchanged, confirming untitled output is identical.
- Live runs against a Token Plan endpoint with `qwen3.8-flash`: the side model opened its reply with `Sources:` in 5 of 5 probe queries. Titles were attached to every listed page in 4 of them; the fifth attached none, its narration was not captured so the cause is unknown, and an immediate re-run of that query attached all three titles. End-to-end runs showed titled links in the tool result and in the model's final `Sources:` section.

## Acceptance criteria

- The narration in the tool result equals the side model's text byte for byte.
- Only URLs the search returned or the agent opened receive titles; titles never come from extractor output.
- Untitled results match the previous output.
- All page comparisons go through `sourceKey`.
- Rendered links fit the CLI's inline-link pattern; destination-naming titles fall back to bare URLs.

## Follow-up

- Make the side-request budget configurable and revisit its default (separate change).
- Per-result summaries, when a backend that returns them is added.
