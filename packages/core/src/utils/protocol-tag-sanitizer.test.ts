/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  stripAnalysisSummaryProtocolTags,
  TopLevelProtocolTagStreamFilter,
} from './protocol-tag-sanitizer.js';

describe('protocol tag sanitizer', () => {
  it('streams summary text while dropping analysis across chunk boundaries', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(filter.accept('<ana')).toBe('');
    expect(filter.accept('lysis>hidden</analysis><sum')).toBe('');
    expect(filter.accept('mary>visible')).toBe('visible');
    expect(filter.accept(' now</summary>')).toBe(' now');
    expect(filter.flush()).toBe('');
  });

  it('preserves summary whitespace exactly', () => {
    const input = '<summary>function f() {\n    return 1;\n}</summary>';

    expect(stripAnalysisSummaryProtocolTags(input)).toBe(
      'function f() {\n    return 1;\n}',
    );
  });

  it.each([
    '<analysis-notes>keep me</analysis-notes>',
    '<analysis:notes>keep me</analysis:notes>',
    '<summary-report>keep me</summary-report>',
  ])('preserves non-protocol tag %s', (input) => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(filter.accept(input) + filter.flush()).toBe(input);
    expect(stripAnalysisSummaryProtocolTags(input)).toBe(input);
  });

  it('handles a stray closing tag and fails closed on an incomplete protocol tag', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(
      filter.accept('</analysis><summary>visible</summary>') + filter.flush(),
    ).toBe('visible');

    const incomplete = new TopLevelProtocolTagStreamFilter();
    expect(incomplete.accept('<analysis')).toBe('');
    expect(incomplete.flush()).toBe('');
  });

  it('does not enter analysis mode for a self-closing tag', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(
      filter.accept('<analysis/><summary>visible</summary>') + filter.flush(),
    ).toBe('visible');
  });

  it('recovers a summary after an unclosed analysis block', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(filter.accept('<analysis>hidden<sum')).toBe('');
    expect(filter.accept('mary>visible</summary>')).toBe('');
    expect(filter.flush()).toBe('visible');
  });

  it('keeps a nested summary hidden when the analysis block later closes', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(
      filter.accept(
        '<analysis>hidden<summary>nested</summary></analysis>' +
          '<summary>visible</summary>',
      ) + filter.flush(),
    ).toBe('visible');
  });

  it('clears malformed recovery state on reset', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(filter.accept('<analysis>hidden<summary>stale')).toBe('');
    filter.reset();
    expect(filter.accept('<summary>fresh</summary>') + filter.flush()).toBe(
      'fresh',
    );
  });
});
