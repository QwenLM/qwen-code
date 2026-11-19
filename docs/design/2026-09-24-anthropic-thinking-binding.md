# Preserve Claude thinking across tool calls

[English](2026-09-24-anthropic-thinking-binding.md) | [简体中文](2026-09-24-anthropic-thinking-binding.zh-CN.md)

## Problem

A Claude Opus 5.5 tool continuation failed with a 400 `Invalid signature in thinking block`. The successful response contained signed thinking ending in two newlines. History consolidation removed those newlines while retaining the signature. Background MCP discovery also changed the tool declarations between requests, which changes the conversation prefix bound to the thinking block.

## Change

Keep thinking text byte-for-byte when consolidating history, including signed blocks with empty text. Use trimming only to discard unsigned empty text. For Claude Opus 5.5 and Fable 5.1 adaptive requests, send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` with the `thinking-binding-controls-2026-08-01` beta header from the first request onward. This lets the service discard a block bound to a changed prefix while keeping the request setting stable across turns. If an Anthropic-compatible proxy explicitly rejects `block_binding`, retry once without it and omit it on later requests from that generator.

## Validation and limits

Unit tests cover trailing whitespace, empty signed blocks, unsigned whitespace-only blocks, changed tool declarations, both affected model families, and proxy rejection in regular and streaming requests. A fresh interactive Opus 5.5 session replayed signed thinking with its trailing newlines unchanged and completed a tool continuation. The interactive run did not change the tool declarations; that case is covered by the request-construction test. A proxy that rejects the binding control still cannot recover from a genuine prefix mismatch. An already persisted session with altered thinking text should start fresh.
