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

  it('streams literal analysis mentions inside visible summary content', () => {
    const filter = new TopLevelProtocolTagStreamFilter();
    const input =
      '<summary>Fix: replace <analysis> tag in src/app.tsx line 42</summary>';

    expect(filter.accept(input) + filter.flush()).toBe(
      'Fix: replace <analysis> tag in src/app.tsx line 42',
    );
  });

  it('streams literal analysis mentions split across chunk boundaries', () => {
    const filter = new TopLevelProtocolTagStreamFilter();

    const out =
      filter.accept('<summary>Fix: replace <ana') +
      filter.accept('lysis> tag in line 42</summary>') +
      filter.flush();

    expect(out).toBe('Fix: replace <analysis> tag in line 42');
  });

  it('keeps streaming and batch sanitizers aligned on summary-internal analysis', () => {
    const inputs = [
      '<summary>Fix: replace <analysis> tag in src/app.tsx line 42</summary>',
      '<summary>visible <analysis>hidden scratch</analysis></summary>',
      '<summary>Done<analysis/>leaked</summary>',
      '<analysis>hidden</analysis><summary>ref <analysis> tag</summary>',
      '<summary>a <analysis>x</analysis> b <analysis> lit c</summary>',
      '<summary><details><summary>Title</summary><p>Body</p></details></summary>',
    ];

    for (const input of inputs) {
      const batch = stripAnalysisSummaryProtocolTags(input);

      const whole = new TopLevelProtocolTagStreamFilter();
      expect((whole.accept(input) + whole.flush()).trim()).toBe(batch);

      const perChar = new TopLevelProtocolTagStreamFilter();
      let out = '';
      for (const char of input) out += perChar.accept(char);
      out += perChar.flush();
      expect(out.trim()).toBe(batch);
    }
  });

  it('preserves an unclosed literal analysis mention when the summary never closes', () => {
    const filter = new TopLevelProtocolTagStreamFilter();
    const input = '<summary>see <analysis> here';

    expect(filter.accept(input) + filter.flush()).toBe('see <analysis> here');
  });

  it('does not leak </summary> when the summary body has an unmatched "<"', () => {
    const filter = new TopLevelProtocolTagStreamFilter();
    const input =
      '<analysis>ok</analysis><summary>Because 3 < 5, pick the smaller.</summary>';

    expect(filter.accept(input) + filter.flush()).toBe(
      'Because 3 < 5, pick the smaller.',
    );
  });

  it('does not drop the visible answer when the analysis body has an unmatched "<"', () => {
    const filter = new TopLevelProtocolTagStreamFilter();
    const input = '<analysis>3 < 5 so proceed</analysis>Here are your 3 files.';

    expect(filter.accept(input) + filter.flush()).toBe(
      'Here are your 3 files.',
    );
  });

  it('keeps unmatched "<" prose aligned between streaming and batch sanitizers', () => {
    const inputs = [
      '<analysis>ok</analysis><summary>Because 3 < 5, pick the smaller.</summary>',
      '<analysis>3 < 5 so proceed</analysis>Here are your 3 files.',
      '<summary>cmd < input.txt then x</summary>',
      '<summary>if (x<3) return</summary>',
      '<analysis>a < b and c < d</analysis><summary>ans</summary>',
    ];

    for (const input of inputs) {
      const batch = stripAnalysisSummaryProtocolTags(input);

      const whole = new TopLevelProtocolTagStreamFilter();
      expect((whole.accept(input) + whole.flush()).trim()).toBe(batch);

      const perChar = new TopLevelProtocolTagStreamFilter();
      let out = '';
      for (const char of input) out += perChar.accept(char);
      out += perChar.flush();
      expect(out.trim()).toBe(batch);
    }
  });
});
