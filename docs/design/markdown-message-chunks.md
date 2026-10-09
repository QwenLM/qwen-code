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

`channel-base` exports `splitMarkdown(text, { targetLength, maxLength, unit })`.
`unified`, `remark-parse` and `remark-gfm` identify block and inline boundaries.
Source offsets retain original syntax instead of serializing parsed URLs.
Reference link definitions are repeated so references remain resolvable in each
fragment, and their size is reserved. An impossible budget raises an error rather
than emitting an over-budget message or looping indefinitely.

Adapters subtract their prefix budgets before splitting, then add prefixes as
before. DingTalk conservatively reserves the first-message mention on all content
fragments but emits it only on the first. Delivery loops, send order, media
extraction, failure propagation and resumption from the first unsent chunk remain
unchanged. Dependencies are declared directly in channel-base with a synchronized
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

Real DingTalk and WeCom test recipients are required to verify that messages above
3800 are accepted and render correctly, including near the 20,000 maximum. Local
payload capture and Markdown parsing cannot establish either platform result.
Until this is performed, implementation and local verification must be reported
separately from platform acceptance. Platform Markdown dialect differences and
endpoint-specific size restrictions remain risks; sending errors continue through
the existing error paths.
