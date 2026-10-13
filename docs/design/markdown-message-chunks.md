# Markdown message chunking

[English](markdown-message-chunks.md) | [简体中文](markdown-message-chunks.zh-CN.md)

## Problem and scope

DingTalk and WeCom currently split long Markdown inside links, table rows and code fences. Keep the existing ordinary-message delivery paths and add shared structure-aware splitting. Interactive cards, attachments, generic delivery/retry behavior and unrelated refactors are outside this change.

## Contract

The normal target remains 3800; a complete table, code block or inline element may exceed it up to 20,000. DingTalk counts UTF-16 units and WeCom counts UTF-8 bytes. Prefixes, mentions, repeated headers, reference definitions and generated fences consume these budgets. Prefer block, paragraph, list-item and sentence boundaries; keep a heading with the first following fragment when it fits. Preserve original URL spelling and Unicode characters.

Tables above the hard maximum split only between rows and repeat the original two-line header. Oversized code blocks close and reopen fences, retaining language and metadata; prefer line boundaries. An indivisible element that exceeds the maximum uses explicitly labeled plain-text fenced fragments preserving its entire source. This cannot keep an oversized URL clickable across messages.

## Implementation and rationale

A shared `channel-base/markdown-chunks` subpath uses CommonMark source positions rather than Markdown serialization. Validate GFM table candidates with only their two header lines, avoiding full large-table parsing; parse non-table paragraphs for inline boundaries. Split lists at items and quoted content at block boundaries, retaining container markers and their budget. Unsupported oversized structures use the same labeled lossless fallback. Repeat top-level reference definitions in split messages. Nested multiline reference resolution remains outside this change.

DingTalk and WeCom subtract their existing source/mention prefixes before splitting. DingTalk proactive messages additionally measure the actual serialized `{title,text}` JSON against 15,000 UTF-8 bytes, including continuation titles. Recheck after a background header/title is recomposed, before sending. Repacking must not repeat attachment preparation or alter the send/retry loop.

Affected files are the new shared splitter and tests, channel-base package manifest and lockfile, DingTalk Markdown utilities and adapters/tests, and WeCom adapter/tests. The parser is not imported through the general channel-base barrel. No public configuration is added.

## Validation and acceptance

Use synthetic example-domain URLs only. Focused tests must retain complete links and all table rows/headers, preserve code content and fence closure, enforce both counting modes and prefix budgets, and capture serialized proactive payloads after background recomposition. Cover large documents using bounded table detection. Run package-local unit tests, build, bundle, typecheck and lint; perform independent read-only test-engineer verification, two clean self-audits and code review.

Try the global CLI for the baseline and the built CLI for verification. If the CLI cannot reach channel delivery without real platform accounts, use captured adapter payloads and an independent Markdown renderer as a documented test-script fallback.

## Open platform acceptance

The 3800/20,000 values are application budgets, not proof of endpoint acceptance. Real DingTalk session replies and proactive messages, and WeCom Markdown delivery, still require recipient-based capacity and rendering validation. Local serialization and renderer tests cannot establish real platform behavior. This gap remains explicit; it does not change the accepted design.
