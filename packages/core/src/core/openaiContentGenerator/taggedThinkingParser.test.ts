/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  TaggedThinkingParser,
  parseTaggedThinkingText,
} from './taggedThinkingParser.js';

describe('TaggedThinkingParser', () => {
  // ── Basic parsing ─────────────────────────────────────

  it('should leave plain text unchanged', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('hello world', true)).toEqual([
      { text: 'hello world' },
    ]);
  });

  it('should parse <think> content as thought part', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('<think>reasoning</think>answer', true)).toEqual([
      { text: 'reasoning', thought: true },
      { text: 'answer' },
    ]);
  });

  it('should parse <thinking> content as thought part', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('<thinking>r</thinking>a', true)).toEqual([
      { text: 'r', thought: true },
      { text: 'a' },
    ]);
  });

  it('should handle mixed usage of <think> and <thinking>', () => {
    const parser = new TaggedThinkingParser();
    expect(
      parser.parse('<think>a</think>b<thinking>c</thinking>d', true),
    ).toEqual([
      { text: 'a', thought: true },
      { text: 'b' },
      { text: 'c', thought: true },
      { text: 'd' },
    ]);
  });

  // ── Case insensitivity ────────────────────────────────

  it('should handle uppercase <THINK> tags', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('<THINK>a</THINK>b', true)).toEqual([
      { text: 'a', thought: true },
      { text: 'b' },
    ]);
  });

  it('should handle uppercase <THINKING> tags', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('<THINKING>a</THINKING>b', true)).toEqual([
      { text: 'a', thought: true },
      { text: 'b' },
    ]);
  });

  it('should handle mixed-case tags', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('<Think>a</Think>b', true)).toEqual([
      { text: 'a', thought: true },
      { text: 'b' },
    ]);
  });

  // ── Empty tag content ─────────────────────────────────

  it('should handle empty <think></think> tags', () => {
    const parser = new TaggedThinkingParser();
    // Empty thought should not produce a part (appendPart skips empty text)
    expect(parser.parse('before<think></think>after', true)).toEqual([
      { text: 'before' },
      { text: 'after' },
    ]);
  });

  it('should handle empty <thinking></thinking> tags', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('a<thinking></thinking>b', true)).toEqual([
      { text: 'a' },
      { text: 'b' },
    ]);
  });

  // ── Close tags in text mode (no preceding open tag) ───

  it('should treat </think> as normal text in text mode (no opening tag)', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('some </think> text', true)).toEqual([
      { text: 'some </think> text' },
    ]);
  });

  it('should treat </thinking> as normal text in text mode (no opening tag)', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('x </thinking> y', true)).toEqual([
      { text: 'x </thinking> y' },
    ]);
  });

  // ── Pure partial-tag-prefix chunk (streaming core) ────

  it('should buffer partial tag prefix across chunks', () => {
    const parser = new TaggedThinkingParser();

    // "<thi" could be start of <think> or <thinking>
    const r1 = parser.parse('pre <thi');
    expect(r1).toEqual([{ text: 'pre ' }]);

    // Complete the tag
    const r2 = parser.parse('nk>hidden</think>visible', true);
    expect(r2).toEqual([
      { text: 'hidden', thought: true },
      { text: 'visible' },
    ]);
  });

  it('should handle chunk that is only a partial tag prefix', () => {
    const parser = new TaggedThinkingParser();

    // Entire chunk is just a partial tag prefix
    const r1 = parser.parse('<thi');
    expect(r1).toEqual([]);

    const r2 = parser.parse('nking>thought</thinking>out', true);
    expect(r2).toEqual([{ text: 'thought', thought: true }, { text: 'out' }]);
  });

  it('should handle close tag partial prefix (< + /th...) in thought mode', () => {
    const parser = new TaggedThinkingParser();

    // Enter thought mode; "</th" is a partial prefix of </think> → buffered
    expect(parser.parse('<think>content </th')).toEqual([
      { text: 'content ', thought: true },
    ]);

    // On final, buffered "</th" + new "ink> visible" → completes </think>
    // → exits thought mode. " visible" is normal text.
    expect(parser.parse('ink> visible', true)).toEqual([{ text: ' visible' }]);
  });

  // ── Multi-chunk tag splitting ─────────────────────────

  it('should handle tag split across 3+ chunks', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('a <th')).toEqual([{ text: 'a ' }]);
    expect(parser.parse('in')).toEqual([]);
    expect(parser.parse('k>hidden</think>b', true)).toEqual([
      { text: 'hidden', thought: true },
      { text: 'b' },
    ]);
  });

  it('should handle close tag split across chunks', () => {
    const parser = new TaggedThinkingParser();

    expect(parser.parse('<think>thought</')).toEqual([
      { text: 'thought', thought: true },
    ]);
    expect(parser.parse('think>visible', true)).toEqual([{ text: 'visible' }]);
  });

  // ── final flag: flush unclosed tags ───────────────────

  it('should flush unclosed thinking content as thought on final', () => {
    const parser = new TaggedThinkingParser();
    // "<think>stuff" without closing tag → on final, thought is flushed
    expect(parser.parse('answer <think>reasoning', true)).toEqual([
      { text: 'answer ' },
      { text: 'reasoning', thought: true },
    ]);
  });

  it('should preserve incomplete open tag as text on final', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('text <thi', true)).toEqual([{ text: 'text <thi' }]);
  });

  it('should flush unclosed partial close tag in thought mode on final', () => {
    const parser = new TaggedThinkingParser();
    expect(parser.parse('<think>stuff</thi', true)).toEqual([
      { text: 'stuff</thi', thought: true },
    ]);
  });

  // ── Multiple alternating tag blocks ───────────────────

  it('should handle multiple alternating think blocks without final', () => {
    const parser = new TaggedThinkingParser();

    const r1 = parser.parse('<think>a</think>');
    expect(r1).toEqual([{ text: 'a', thought: true }]);

    const r2 = parser.parse('b<thinking>c</thinking>d', true);
    expect(r2).toEqual([
      { text: 'b' },
      { text: 'c', thought: true },
      { text: 'd' },
    ]);
  });

  // ── Static convenience method ─────────────────────────

  it('parseTaggedThinkingText should work as a one-shot parser', () => {
    expect(parseTaggedThinkingText('<think>x</think>y')).toEqual([
      { text: 'x', thought: true },
      { text: 'y' },
    ]);
  });

  it('parseTaggedThinkingText handles plain text', () => {
    expect(parseTaggedThinkingText('no tags here')).toEqual([
      { text: 'no tags here' },
    ]);
  });

  it('parseTaggedThinkingText preserves incomplete tags as visible text', () => {
    expect(parseTaggedThinkingText('final <thi')).toEqual([
      { text: 'final <thi' },
    ]);
  });

  // ── Cross-matching tags (binary mode toggle) ──────────

  it('should handle cross-matching: <think> content </thinking>', () => {
    const parser = new TaggedThinkingParser();
    // Binary mode toggle allows </thinking> to close <think>
    expect(parser.parse('<think>reasoning</thinking>visible', true)).toEqual([
      { text: 'reasoning', thought: true },
      { text: 'visible' },
    ]);
  });

  it('should handle cross-matching: <thinking> content </think>', () => {
    const parser = new TaggedThinkingParser();
    // Binary mode toggle allows </think> to close <thinking>
    expect(parser.parse('<thinking>reasoning</think>visible', true)).toEqual([
      { text: 'reasoning', thought: true },
      { text: 'visible' },
    ]);
  });

  // ── Unclosed thought flush on stream end ────────────────

  it('should flush unclosed thought as thought part on final (stream truncated after <think>)', () => {
    const parser = new TaggedThinkingParser();
    // Simulate stream truncation: <think> opened, network drops, final flush
    // The content is flushed as thought (invisible to user), but the debugLogger.warn
    // makes this observable. This test verifies the flush behavior itself.
    expect(parser.parse('<think>partial response', true)).toEqual([
      { text: 'partial response', thought: true },
    ]);
  });

  it('should flush unclosed thought as text when stream ends with visible prefix', () => {
    const parser = new TaggedThinkingParser();
    // <think> opens thought mode, </think> closes it, then another <think> opens
    // but stream ends before closing → final flush as thought
    expect(
      parser.parse('<think>done</think>visible <think>unclosed', true),
    ).toEqual([
      { text: 'done', thought: true },
      { text: 'visible ' },
      { text: 'unclosed', thought: true },
    ]);
  });
});
