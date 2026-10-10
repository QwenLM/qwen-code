# Markdown message chunking

[English](markdown-message-chunks.md) | [简体中文](markdown-message-chunks.zh-CN.md)

## Problem and scope

DingTalk currently cuts replies at 3800 UTF-16 units, including inside Markdown
links. WeCom cuts at 3800 UTF-8 bytes and can start a continued table without its
header. Long percent-encoded citation URLs make both failures visible in the
synthetic knowledge-search regression fixture.

This change covers DingTalk ordinary replies, proactive messages and ordinary
message fallbacks, plus WeCom Markdown sends. It does not change interactive
status cards, personal Weixin, media delivery, user configuration, or attachments.

## Chunking contract

The soft target is 3800; the hard maximum is 20,000. These are application budgets,
not a claim that every platform endpoint accepts 20,000. DingTalk measures UTF-16
units and WeCom measures UTF-8 bytes. Escaped source labels, the first-message
mention, repeated table headers and generated fences consume the same budget.

Messages below 20,000 still split near the target. Prefer section, paragraph,
list-item, table and code boundaries. End the current message before a complete
block that would take it above the target. Keep headings with the first following
content fragment. Long sections split internally. A complete table, code block or
inline element between the target and maximum stays intact.

A table above the maximum splits by complete rows, repeating the original header
and delimiter row. An oversized row falls back to explicitly labeled plain-text
code fragments, including its header. Code above the maximum splits at line
boundaries, closing and reopening fences and preserving language and metadata.
A single long code line uses Unicode-safe cuts. Long paragraphs protect complete
inline elements and prefer sentence endings or whitespace in text. No surrogate
pair is cut in either counting mode.

An indivisible element above the maximum is preceded by an explicit notice and
sent as plain text in fenced fragments. Its entire original source is retained,
including the complete URL and `__dac_citation` payload. This fallback cannot keep
an oversized link clickable across messages; it makes that limitation visible.
No URL shortening, metadata stripping or file upload is performed.

## Implementation

`channel-base/markdown-chunks` exports `splitMarkdown(text, { targetLength, maxLength, unit })`; the general barrel exports only its option type so daemon startup does not load the parser.
`unified`, `remark-parse` and `remark-gfm` identify block and inline boundaries.
Source offsets retain original syntax instead of serializing parsed URLs.
Reference link definitions, including nested definitions, are repeated so references remain resolvable in each fragment. Large definitions reserve at most half the soft target; a derived hard budget too small for safe rendering falls back to the original document as plain-text code rather than throwing or producing one message per character. An invalid caller-supplied budget raises `RangeError` rather than emitting an over-budget message or looping indefinitely.

Short complete messages retain their exact source. Unfinished fences are still closed. Source separators and sentence-adjacent whitespace are retained; lists split near the target while retaining nesting, and quotes measure their markers on every line. Recursive container rendering stops after 16 levels and sends the remaining original source as labeled plain-text code.

Adapters reject a prefix that exhausts the soft budget, subtract valid prefix budgets before splitting, then add prefixes as before. DingTalk conservatively reserves the first-message mention on all content
fragments but emits it only on the first. Delivery loops, send order, media
extraction, failure propagation and resumption from the first unsent chunk remain
unchanged. DingTalk proactive delivery additionally checks the UTF-8 length of the actual JSON `msgParam` (including title, continuation title, escaped text and source prefix). Only chunks over 15,000 bytes are repacked with a smaller structure-aware budget until every serialized payload fits. This conservative cap also applies to proactive direct messages. Dependencies are declared directly in channel-base with a synchronized
pnpm lockfile.

## Validation and acceptance

The committed fixture contains only synthetic content (no trailing newline):
8704 UTF-16 units, 9438 UTF-8 bytes, 12 citation links, two tables and six data rows.
All URLs use `docs.example.com`, a fictional region and document identifiers, and
generated citation metadata. No original service addresses or business records
are included. A regression assertion checks the permitted synthetic URL shape.
Both counting modes must produce multiple messages, preserve every URL exactly
and retain all rows as tables. In particular, the sixth and tenth citation URLs
must remain intact, and the fifth data row must have a header.

Unit coverage includes target/max boundaries, repeated responses above 20,000,
Chinese and emoji, prefixes, long tables, code languages and long lines, reference
links, inline formatting and the oversized-link fallback. Parse every fragment to
check structure, counts, ordering and content as well as payload size. Adapter
regressions cover ordinary sends, mentions and existing retry/fallback behavior.
The test engineer uses an independent Markdown renderer on captured adapter
payloads. Run targeted tests, build, bundle, typecheck and lint, followed by two
clean self-audits and code review. The E2E plan and local reports live in
`.qwen/e2e-tests/markdown-message-chunks.md`.

## Platform validation and remaining risk

The official [WeCom intelligent-bot WebSocket protocol](https://developer.work.weixin.qq.com/document/path/101463) permits 20,480 UTF-8 bytes for `aibot_send_msg` Markdown content. The 4,096-byte bound of legacy group Webhooks is a different API. The official [DingTalk proactive group API](https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message) limits serialized `msgParam` to 15,000 bytes, which the adapter checks separately from the UTF-16 application budget. A numerical capacity for session Webhook replies and proactive direct messages has not been established here.

Real test recipients are required to verify acceptance and rendering: DingTalk session replies above 3800 and near the 20,000-unit application maximum, WeCom content near 20,000 bytes, and DingTalk proactive JSON payloads near 15,000 bytes. Local
payload capture and Markdown parsing cannot establish either platform result.
Until this is performed, implementation and local verification must be reported
separately from platform acceptance. Platform Markdown dialect differences and
endpoint-specific size restrictions remain risks; sending errors continue through
the existing error paths.
