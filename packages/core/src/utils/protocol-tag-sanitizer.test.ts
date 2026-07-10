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

  it('unwraps protocol summary tags after visible text has started', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(filter.accept('Sure - ')).toBe('Sure - ');
    expect(filter.accept('<summary>answer</summary>') + filter.flush()).toBe(
      'answer',
    );
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

  it('handles single-character chunk splitting', () => {
    const filter = new TopLevelProtocolTagStreamFilter();
    const input = '<analysis>hidden</analysis><summary>ok</summary>';
    let out = '';

    for (const char of input) {
      out += filter.accept(char);
    }
    out += filter.flush();

    expect(out).toBe('ok');
  });

  it.each(['<analyze>', '<suitor>', '<analysisx>'])(
    'treats adversarial prefix %s as non-protocol text',
    (tag) => {
      const filter = new TopLevelProtocolTagStreamFilter();
      const input = `${tag}keep me</${tag.slice(1)}`;

      expect(filter.accept(input) + filter.flush()).toBe(input);
    },
  );

  it('flushes whitespace-only buffer as non-protocol content', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(filter.accept('   ')).toBe('');
    expect(filter.flush()).toBe('   ');
  });

  it('works correctly after reset and reuse', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(
      filter.accept('<analysis>first</analysis><summary>a</summary>') +
        filter.flush(),
    ).toBe('a');

    filter.reset();

    expect(
      filter.accept('<analysis>second</analysis><summary>b</summary>') +
        filter.flush(),
    ).toBe('b');
  });

  it('handles nested analysis inside summary inside analysis', () => {
    const input =
      '<analysis>outer<summary>inner<analysis>deep</analysis></summary></analysis>' +
      '<summary>visible</summary>';

    expect(stripAnalysisSummaryProtocolTags(input)).toBe('visible');
  });

  it('drops an unclosed analysis tail from visible text', () => {
    expect(
      stripAnalysisSummaryProtocolTags('<summary>actual<analysis>scratch'),
    ).toBe('actual');
  });

  it('preserves literal summary tags inside visible summary content', () => {
    const input =
      '<analysis>hidden</analysis>' +
      '<summary><details><summary>Title</summary><p>Body</p></details></summary>';

    expect(stripAnalysisSummaryProtocolTags(input)).toBe(
      '<details><summary>Title</summary><p>Body</p></details>',
    );
  });

  it('streams literal summary tags inside visible summary content', () => {
    const filter = new TopLevelProtocolTagStreamFilter();
    const input =
      '<summary><details><summary>Title</summary><p>Body</p></details></summary>';

    expect(filter.accept(input) + filter.flush()).toBe(
      '<details><summary>Title</summary><p>Body</p></details>',
    );
  });

  it('preserves literal unclosed analysis mentions in visible summary content', () => {
    expect(
      stripAnalysisSummaryProtocolTags(
        '<summary>Fix: replace <analysis> tag in src/app.tsx line 42</summary>',
      ),
    ).toBe('Fix: replace <analysis> tag in src/app.tsx line 42');
  });

  it('keeps only the recovered summary from an unclosed analysis block', () => {
    const input = '<analysis>hidden<summary>visible</summary>still hidden';
    const filter = new TopLevelProtocolTagStreamFilter();

    expect(stripAnalysisSummaryProtocolTags(input)).toBe('visible');
    expect(filter.accept(input) + filter.flush()).toBe('visible');
  });
});
