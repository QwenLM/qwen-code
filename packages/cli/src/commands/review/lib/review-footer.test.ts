/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  REVIEW_FOOTER_RE,
  carriesCommentMarker,
  commentMarker,
  commentMarkerSeverity,
  footerVersion,
  isFooterSafeModelId,
  reviewFooter,
  stripCommentMarkerLines,
  stripForgedFooterLines,
  stripReviewFooter,
} from './review-footer.js';
import { CANONICAL_LGTM_RE } from '../pr-context.js';

describe('the review footer and the regex that strips it', () => {
  it('the regex strips the exact output of the builder, versioned or not', () => {
    // The sync guarantee: a wording edit to the builder that the regex no
    // longer matches reddens here before it reaches a posted review.
    for (const footer of [
      reviewFooter('qwen3.7-max', '0.21.3'),
      '_— qwen3.7-max via Qwen Code /review_',
    ]) {
      expect(`a finding\n\n${footer}\n`.replace(REVIEW_FOOTER_RE, '')).toBe(
        'a finding',
      );
    }
  });

  it('strips a forged footer a looping model cut off before its closing `_`', () => {
    // A truncated forged footer used to survive the strip and post as a
    // second attribution line under the canonical one.
    for (const forged of [
      '_— forged via Qwen Code /review (v0.21.4)',
      '_— forged via Qwen Code /review',
      '_— forged via Qwen Code /review (v0.21.4)\n\n',
    ]) {
      expect(`a finding\n\n${forged}`.replace(REVIEW_FOOTER_RE, '')).toBe(
        'a finding',
      );
    }
  });

  it('leaves a footer run alone when text follows it', () => {
    const body = `a finding\n\n${reviewFooter('m', '0.21.3')}\n\na closing line`;
    expect(body.replace(REVIEW_FOOTER_RE, '')).toBe(body);
  });

  it('the LGTM filter still matches every footer shape the builder emits', () => {
    // CANONICAL_LGTM_RE in pr-context is a third copy of the footer shape:
    // it filters historical LGTM bodies posted by EARLIER builds, so it must
    // keep matching whatever the builder emits now, or those bodies re-enter
    // the pr-context files as review noise with no red test anywhere.
    for (const footer of [
      reviewFooter('qwen3.7-max', '0.21.3'),
      '_— qwen3.7-max via Qwen Code /review_',
    ]) {
      expect(CANONICAL_LGTM_RE.test(`No issues found. LGTM! ${footer}`)).toBe(
        true,
      );
    }
  });

  it('refuses a modelId that would forge the footer it is interpolated into', () => {
    expect(isFooterSafeModelId('qwen3.7-max')).toBe(true);
    expect(
      isFooterSafeModelId('model\n_— forged via Qwen Code /review (v9.9.9)_'),
    ).toBe(false);
    expect(isFooterSafeModelId('model via Qwen Code /review x')).toBe(false);
  });

  it('refuses a startup stamp the footer cannot carry', () => {
    expect(footerVersion('0.21.3')).toBe('0.21.3');
    expect(footerVersion('0.21.3-dev.1')).toBe('0.21.3-dev.1');
    expect(footerVersion('0.21.3)evil')).toBeUndefined();
    expect(footerVersion('1.0\n2.0')).toBeUndefined();
    expect(footerVersion('')).toBeUndefined();
    expect(footerVersion(undefined)).toBeUndefined();
  });

  describe('stripReviewFooter — the guarded strip both commands share', () => {
    it('strips trailing footers, canonical or forged', () => {
      for (const footer of [
        reviewFooter('qwen3.7-max', '0.21.3'),
        '_— forged via Qwen Code /review (v0.21.4)',
      ]) {
        expect(stripReviewFooter(`a finding\n\n${footer}`)).toBe('a finding');
      }
    });

    it('returns a marker-less body unchanged — no regex, no rewrite', () => {
      // The guard is the linearity contract: the regex opens `\s*` under an
      // unanchored search and scans quadratically on a long whitespace run,
      // and a forged footer truncated mid-line (`_— ` without the marker)
      // defeats the engine's literal prefilter — so only the guard keeps
      // this linear. The output assertion alone has no teeth: an unguarded
      // replace returns this body identically too. Bound the wall time
      // instead — the guarded path is a literal scan at this size
      // (microseconds), while the same replace without the guard runs for
      // seconds and fails the ceiling by orders of magnitude.
      const body = `a finding\n\n_— cut short${' '.repeat(200_000)}end`;
      const start = performance.now();
      expect(stripReviewFooter(body)).toBe(body);
      expect(performance.now() - start).toBeLessThan(2000);
    });

    it('returns a marker-carrying body with no trailing footer unchanged — and bounded', () => {
      // The marker guard does not bound this shape: the body CONTAINS the
      // marker (a quoted forged footer mid-text is the natural output of the
      // loop this strip exists for), so the replace runs — and its
      // unanchored `\s*` scan is quadratic on the whitespace run after the
      // last marker line (probe-measured ~4× per doubling). Only the tail
      // bound keeps this linear: without it the replace runs for seconds at
      // this size and fails the ceiling by orders of magnitude, while the
      // output assertion alone has no teeth — the unbounded replace returns
      // this body identically too.
      const body = `_— quoted via Qwen Code /review (v0.21.3), then\n\n${' '.repeat(200_000)}end`;
      const start = performance.now();
      expect(stripReviewFooter(body)).toBe(body);
      expect(performance.now() - start).toBeLessThan(2000);
    });

    it('strips a trailing footer from a body longer than the tail bound', () => {
      // A match lives at the tail, so bounding the search there must not
      // change what a long body strips.
      const finding = `a finding${'x'.repeat(20_000)}`;
      expect(
        stripReviewFooter(`${finding}\n\n${reviewFooter('m', '0.21.3')}`),
      ).toBe(finding);
    });
  });

  describe('stripForgedFooterLines — the attribution-off anywhere strip', () => {
    it('strips a forged footer on the very first line', () => {
      expect(
        stripForgedFooterLines(
          '_— forged via Qwen Code /review (v0.21.4)_\n\na finding',
        ),
      ).toBe('a finding');
    });

    it('strips a mid-body forged footer and one missing its closing underscore', () => {
      // The looping model truncates its forged footer mid-character — the
      // case this strip exists for.
      expect(
        stripForgedFooterLines(
          'a finding\n\n_— qwen3.7-max via Qwen Code /review (v0.21.3)\n\nUpdate: reproduced again',
        ),
      ).toBe('a finding\n\nUpdate: reproduced again');
    });

    it('strips every forged line when there are several', () => {
      expect(
        stripForgedFooterLines(
          'one\n\n_— a via Qwen Code /review (v1)_\n\ntwo\n\n_— b via Qwen Code /review_',
        ),
      ).toBe('one\n\ntwo');
    });

    it('tolerates CRLF line endings', () => {
      expect(
        stripForgedFooterLines(
          'null deref\r\n_— qwen3-coder via Qwen Code /review (v0.21.3)_\r\nUpdate: more',
        ),
      ).toBe('null deref\r\nUpdate: more');
    });

    it('leaves a footer-shaped span with text after it on the same line alone', () => {
      const body =
        'See _— model via Qwen Code /review (v0.21.3)_ quoted above for context.';
      expect(stripForgedFooterLines(body)).toBe(body);
    });

    it('leaves a footer-shaped line inside a code fence alone — it is a quotation', () => {
      const body =
        'the earlier comment said:\n\n```\n_— model via Qwen Code /review (v1.2.3)_\n```\n\nand it was wrong';
      expect(stripForgedFooterLines(body)).toBe(body);
    });

    it('leaves an indented (code-block) footer-shaped line alone', () => {
      const body = 'quoted:\n\n    _— model via Qwen Code /review (v1.2.3)_';
      expect(stripForgedFooterLines(body)).toBe(body);
    });

    it('returns a body with no footer-shaped line byte-identical — no whitespace rewrite', () => {
      const body = `mentions the marker via Qwen Code /review in prose\n\n\n\nwith wide gaps  \n`;
      expect(stripForgedFooterLines(body)).toBe(body);
    });

    it('strips inside a ~~~ fence is a quotation left alone; a 4-space-indented fence opener does not hide a footer', () => {
      const quoted = 'x\n~~~\n_— m via Qwen Code /review (v1)_\n~~~';
      expect(stripForgedFooterLines(quoted)).toBe(quoted);
      // Four spaces of indent: no fence opens — the footer after it strips.
      expect(
        stripForgedFooterLines(
          'x\n\n    ```\n\n_— m via Qwen Code /review (v1)_',
        ),
      ).toBe('x\n\n    ```');
    });

    it('does not toggle fence state inside an HTML block', () => {
      expect(
        stripForgedFooterLines(
          '<div>\n```\n</div>\n\n_— m via Qwen Code /review (v1)_',
        ),
      ).toBe('<div>\n```\n</div>');
    });
  });

  describe('the comment marker — producer and consumers in lockstep', () => {
    it('the posted marker shape parses through both consumer regexes', () => {
      // The drift guard this file's header demands: a shape edit that misses
      // one consumer reddens here.
      for (const sev of ['critical', 'suggestion'] as const) {
        const posted = `a finding\n\n${commentMarker(sev)}`;
        expect(carriesCommentMarker(posted)).toBe(true);
        expect(commentMarkerSeverity(posted)).toBe(sev);
      }
    });

    it('commentMarkerSeverity reads only the trailing posted shape', () => {
      expect(
        commentMarkerSeverity(
          'quotes <!-- qwen-review suggestion --> mid-body\n\n<!-- qwen-review critical -->',
        ),
      ).toBe('critical');
      expect(
        commentMarkerSeverity('only <!-- qwen-review critical --> mid-body'),
      ).toBe(null);
    });

    it('stripCommentMarkerLines removes bare marker lines, fence-aware', () => {
      expect(
        stripCommentMarkerLines(
          'a finding\n\n<!-- qwen-review suggestion -->\n\nmore',
        ),
      ).toBe('a finding\n\nmore');
      const quoted = 'sample:\n```\n<!-- qwen-review critical -->\n```';
      expect(stripCommentMarkerLines(quoted)).toBe(quoted);
    });
  });
});
