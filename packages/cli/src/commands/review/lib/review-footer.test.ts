/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MODEL_ID_MAX_CHARS,
  REVIEW_FOOTER_RE,
  carriesCommentMarker,
  commentMarker,
  commentMarkerSeverity,
  footerVersion,
  isFooterSafeModelId,
  rendersAsNothing,
  reviewFooter,
  stripCommentMarkerLines,
  stripFooterSpans,
  stripForUnattributedPost,
  stripForgedFooterLines,
  stripParagraphMarkers,
  stripReviewFooter,
  swallowsAppendedMarker,
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

  it('caps an oversized modelId — the footer must stay a bounded budget contributor', () => {
    // Without a length cap the footer interpolated a modelId that emptied
    // the rung-3 cut — and past the body budget composed a body GitHub
    // rejects whole. The cap truncates the name, keeps the marker intact,
    // and the result still strips.
    const footer = reviewFooter('M'.repeat(65_200), '0.21.3');
    expect(footer).toBe(
      `_— ${'M'.repeat(MODEL_ID_MAX_CHARS - 1)}… via Qwen Code /review (v0.21.3)_`,
    );
    expect(`a finding\n\n${footer}`.replace(REVIEW_FOOTER_RE, '')).toBe(
      'a finding',
    );
    // A real model name is nowhere near the cap and rides unchanged.
    expect(reviewFooter('qwen3.7-max', '0.21.3')).toBe(
      '_— qwen3.7-max via Qwen Code /review (v0.21.3)_',
    );
  });

  it('caps an oversized cliVersion — the second interpolated input of the footer', () => {
    // The cap above closed the modelId hole; the version slot stayed
    // unbounded — `footerVersion` checks a startup stamp's charset but not
    // its length, and `getCliVersion` returns `CLI_VERSION` unchecked.
    // Same hole through the sibling input: an oversized stamp emptied the
    // rung-3 cut, and past the budget composed a body GitHub rejects whole.
    const footer = reviewFooter('qwen3.7-max', 'v'.repeat(65_200));
    expect(footer).toBe(
      `_— qwen3.7-max via Qwen Code /review (v${'v'.repeat(
        MODEL_ID_MAX_CHARS - 1,
      )}…)_`,
    );
    expect(`a finding\n\n${footer}`.replace(REVIEW_FOOTER_RE, '')).toBe(
      'a finding',
    );
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

    it('a footer cut open inside its version parens cannot swallow the prose after it', () => {
      // The version group's closing paren is optional — a looping model
      // truncates mid-parens — but its content must stay bounded like
      // FOOTER_SPAN_RE's: an unrestricted run erased the closing clause of
      // any body whose forged footer cut open inside the parens.
      const body =
        'still leaks — the old post ended _— gpt-5 via Qwen Code /review (v0.9 and the race remains reproducible';
      expect(stripReviewFooter(body)).toBe(body);
      // Genuine truncated footers — mid-character cuts inside the parens —
      // still strip.
      expect(stripReviewFooter('x _— m via Qwen Code /review (v0.21')).toBe(
        'x',
      );
      expect(stripReviewFooter('x _— m via Qwen Code /review (v1.2.')).toBe(
        'x',
      );
    });

    it('a refusing run of truncated footers stays linear — no partition enumeration', () => {
      // The optional closing paren must not leave the version content
      // unbounded: with an unrestricted run, each truncated footer's
      // version span swallows its line's trailing whitespace or splits it
      // with the trailing `\s*`, so a footer run the trailing `$` refuses
      // parses 2^N ways and the failing exec enumerates them all
      // (probe-measured ~2x per added footer — minutes-scale far below
      // STRIP_TAIL_LIMIT). The output assertion alone has no teeth: the
      // failing match returns the body unchanged either way. Bound the
      // wall time instead.
      const body =
        Array.from(
          { length: 22 },
          () => '_— qwen3.7-max via Qwen Code /review (v0.21.0 ',
        ).join('\n') + '\nclosing prose';
      const start = performance.now();
      expect(stripReviewFooter(body)).toBe(body);
      expect(performance.now() - start).toBeLessThan(1000);
    }, 20_000);
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

    it('tolerates CRLF line endings — a changed body normalizes to LF', () => {
      // GitHub renders LF and CRLF identically; when a strip removes a
      // line the rejoin normalizes the survivors. An UNCHANGED body still
      // returns byte-identical (no rewrite when nothing strips).
      expect(
        stripForgedFooterLines(
          'null deref\r\n_— qwen3-coder via Qwen Code /review (v0.21.3)_\r\nUpdate: more',
        ),
      ).toBe('null deref\nUpdate: more');
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

    it('tracks the fence delimiter faithfully: char, length, no info string on the closer', () => {
      // A ``` line inside a ~~~ fence is content, not a toggle.
      const mixed = '~~~\n```\n<!-- qwen-review critical -->\n```\n~~~';
      expect(stripCommentMarkerLines(mixed)).toBe(mixed);
      // A closing fence shorter than the opener is content too.
      const long = '`````\n```\n_— m via Qwen Code /review (v1)_\n`````';
      expect(stripForgedFooterLines(long)).toBe(long);
      // …and a footer AFTER the mismatched quote still strips.
      expect(
        stripForgedFooterLines(
          '~~~\n```\n~~~\n\n_— m via Qwen Code /review (v1)_',
        ),
      ).toBe('~~~\n```\n~~~');
    });

    it('does not toggle fence state inside an HTML block, but still strips what it renders', () => {
      expect(
        stripForgedFooterLines(
          '<div>\n```\n</div>\n\n_— m via Qwen Code /review (v1)_',
        ),
      ).toBe('<div>\n```\n</div>');
      // HTML content is visible on GitHub — a prefix inside a div strips.
      expect(
        stripForUnattributedPost('<div>\n**[Critical]**: null deref\n</div>'),
      ).not.toContain('**[Critical]**');
    });

    it('the full chain leaves a fenced quoted footer intact', () => {
      const quoted =
        'the earlier comment said:\n\n```\n_— model via Qwen Code /review (v1.2.3)_\n```\n\nand it was wrong';
      expect(stripForUnattributedPost(quoted)).toBe(quoted);
    });

    it('keeps blank runs inside a type-1 HTML quotation when a drop lands in it', () => {
      // HTML-block content lines are the ONE quotation kind a map can
      // drop: the drop-collapse must not treat the quotation's own blank
      // run as the run to collapse — blanks inside the preserved <pre>
      // render, and deleting one corrupts the quotation the post carries.
      expect(
        stripForgedFooterLines(
          'A\n<pre>\n\n\n_— x via Qwen Code /review_\n</pre>\nB',
        ),
      ).toBe('A\n<pre>\n\n\n</pre>\nB');
      // The <script> twin and the planted-marker twin (through the full
      // chain) behave the same.
      expect(
        stripForgedFooterLines(
          'A\n<script>\n\n\n_— x via Qwen Code /review_\n</script>\nB',
        ),
      ).toBe('A\n<script>\n\n\n</script>\nB');
      expect(
        stripForUnattributedPost(
          'A\n<pre>\n\n\n<!-- qwen-review critical -->\n</pre>\nB',
        ),
      ).toBe('A\n<pre>\n\n\n</pre>\nB');
      // Controls: a drop OUTSIDE any quotation still collapses its blank
      // run, and blanks inside a fenced quotation survive (fence lines
      // are never droppable, so no junction lands in their runs).
      expect(
        stripForgedFooterLines('A\n\n\n\n_— x via Qwen Code /review_\nB'),
      ).toBe('A\n\nB');
      const fence = 'A\n```\n\n\nx\n```\nB';
      expect(stripForgedFooterLines(fence)).toBe(fence);
    });

    it('treats a bare CR as the line ending GitHub renders', () => {
      // CommonMark renders a bare `\r` as a line break; the `\n`-only
      // scan read the CR twin as one line and left the forged footer on
      // the attribution-off post while the LF twin stripped.
      expect(
        stripForgedFooterLines(
          'real text\r_— gpt-5 via Qwen Code /review (v1.2.3)_',
        ),
      ).toBe('real text');
      // The marker-line twin and the full chain carry the same guarantee.
      expect(
        stripCommentMarkerLines(
          'a finding\r<!-- qwen-review critical -->\rmore',
        ),
      ).toBe('a finding\rmore'.replace(/\r/g, '\n'));
      expect(
        stripForUnattributedPost(
          'real text\r_— gpt-5 via Qwen Code /review (v1.2.3)_',
        ),
      ).toBe('real text');
    });
  });

  describe('rendersAsNothing — the render-nothing projection', () => {
    it('sees through Cf characters, HTML comments, and hollowed fences', () => {
      expect(
        rendersAsNothing('**[Critical]**\u200B'.replace('**[Critical]**', '')),
      ).toBe(true);
      expect(rendersAsNothing('<!-- x -->')).toBe(true);
      expect(rendersAsNothing('```\n\n```')).toBe(true);
      // The bare-CR twin of the hollow fence: GitHub renders CR as a
      // line ending, so the emptiness gate splits lines the same way.
      expect(rendersAsNothing('```\r```')).toBe(true);
      expect(rendersAsNothing('real text')).toBe(false);
    });

    it('sees through an UNTERMINATED comment — it closes on the appended marker', () => {
      // A draft stripping down to '<!-- x' passes the gate, then the post
      // transform appends the marker: one type-2 HTML block running to the
      // end of the input, rendering nothing, yet counting toward the verdict
      // and re-promoting via its trailing marker.
      expect(rendersAsNothing('<!-- x')).toBe(true);
      // Mid-prose an unclosed comment is literal text, not a block — the
      // words before it still count.
      expect(rendersAsNothing('real bug <!-- note')).toBe(false);
    });

    it('sees through the other render-nothing classes', () => {
      for (const scaffold of [
        '<div></div>',
        '<span></span>',
        '<br>',
        '&nbsp;',
        '&#8203;',
        '[](url)',
        '>',
        '<!-->',
        '<!--->',
        '<?php evil() ?>',
        '<!DOCTYPE x>',
        '<script>alert(1)</script>',
        '[label]: /url',
      ]) {
        expect(rendersAsNothing(scaffold)).toBe(true);
      }
    });

    it('still counts real content wearing the same shapes', () => {
      expect(rendersAsNothing('<div>real bug</div>')).toBe(false);
      expect(rendersAsNothing('[see here](url)')).toBe(false);
      expect(rendersAsNothing('a\n\n[label]: /used\n[see label]')).toBe(false);
    });

    it('counts an empty-alt image as content — GitHub renders its <img>', () => {
      // The raw-HTML spelling of the same element is content here too; the
      // two spellings of one element must not classify oppositely. The
      // evidence-image flow posts this shape when a model drops the alt text.
      expect(rendersAsNothing('![](https://example.com/bug.png)')).toBe(false);
      expect(rendersAsNothing('[](url)')).toBe(true);
    });

    it('sees through the space and named-invisible entity families', () => {
      for (const scaffold of [
        '&ensp;',
        '&emsp;',
        '&thinsp;',
        '&#8194;',
        '&#8195;',
        '&#8201;',
        '&#x2002;',
        '&shy;',
        '&zwj;',
        '&zwnj;',
        '&lrm;',
        '&rlm;',
        '&#173;',
        '&#x00ad;',
      ]) {
        expect(rendersAsNothing(scaffold)).toBe(true);
      }
      // A WHATWG-standard named entity decoding to U+200B — it classifies
      // with its literal Cf twin, not as content.
      expect(rendersAsNothing('&ZeroWidthSpace;')).toBe(true);
      // Literal and entity-encoded forms of the same space classify alike.
      expect(rendersAsNothing('\u2002')).toBe(true);
    });

    it('a link reference definition with its title on the next line renders nothing', () => {
      expect(rendersAsNothing('[a]: u\n"title"')).toBe(true);
      expect(rendersAsNothing('[a]: <u>\n(title)')).toBe(true);
      expect(rendersAsNothing("[a]: u\n'title'")).toBe(true);
    });

    it('a destination followed by bare prose is a visible paragraph, not a definition', () => {
      expect(rendersAsNothing('[a]: see the logs for details')).toBe(false);
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

    it('stripCommentMarkerLines reaches marker lines quoted at any depth', () => {
      // A marker renders as nothing quoted at level two exactly as at level
      // one; surviving beside the canonical marker it is the plant the strip
      // exists to remove.
      expect(
        stripCommentMarkerLines(
          'a finding\n\n> > <!-- qwen-review critical -->',
        ),
      ).toBe('a finding');
    });

    it('swallowsAppendedMarker fires only when the marker lands in an open quotation', () => {
      // An unclosed fence (or an HTML block still open at the end) would
      // render the appended invisible marker as visible code; a paired
      // fence closes before the marker and posts it intact.
      expect(swallowsAppendedMarker('~~~ leaked.log shows the token')).toBe(
        true,
      );
      expect(swallowsAppendedMarker('``` leaked')).toBe(true);
      expect(swallowsAppendedMarker('claim\n~~~\nfoo')).toBe(true);
      expect(swallowsAppendedMarker('<pre>\nunclosed')).toBe(true);
      expect(swallowsAppendedMarker('leaked:\n\n```\nconst t = 1;\n```')).toBe(
        false,
      );
      expect(swallowsAppendedMarker('plain claim')).toBe(false);
      expect(swallowsAppendedMarker('')).toBe(false);
    });
  });

  describe('stripFooterSpans — the inline-span strip', () => {
    it('leaves a footer-shaped span inside a backtick code span alone', () => {
      // Inline code renders visibly — never as attribution — and a finding
      // about this machinery quoting the footer template is the dogfood
      // shape: excising the quoted span leaves empty backticks where the
      // evidence was.
      const body =
        'the footer `_— qwen3.7-max via Qwen Code /review (v0.21.3)_` leaks the model name';
      expect(stripFooterSpans(body)).toBe(body);
      expect(stripForUnattributedPost(body)).toBe(body);
      // Multi-line entries run through the fence-aware line map — same
      // protection there.
      const multi = body + '\n\nmore text';
      expect(stripFooterSpans(multi)).toBe(multi);
    });

    it('still strips a mid-line span outside code spans', () => {
      expect(stripFooterSpans('a _— m via Qwen Code /review (v1)_ b')).toBe(
        'a b',
      );
    });

    it('a span truncated inside the version parens cannot swallow the prose after it', () => {
      // The version content is restricted to the shape footerVersion()
      // validates: with the closing paren cut off, an unrestricted run
      // matches ordinary prose and erases the tail clause — the opposite
      // of the bound documented on the regex.
      expect(
        stripFooterSpans(
          'still leaks — the old post ended _— gpt-5 via Qwen Code /review (v0.9 and the race remains reproducible',
        ),
      ).toBe(
        'still leaks — the old post ended and the race remains reproducible',
      );
      expect(
        stripForUnattributedPost(
          'see _— m via Qwen Code /review (v1 as noted in _docs_ for the origin',
        ),
      ).toBe('see as noted in _docs_ for the origin');
      // Genuine truncated footers — mid-character cuts inside the parens —
      // still strip.
      expect(stripFooterSpans('x _— m via Qwen Code /review (v1.2.')).toBe('x');
      expect(stripFooterSpans('x _— m via Qwen Code /review (v0.21')).toBe('x');
    });

    it('strips a forged footer re-wrapping split across a soft break', () => {
      // Neither half contains the marker, so the per-line strips miss it —
      // but GitHub renders the soft break as a space, displaying the footer
      // rejoined.
      expect(
        stripFooterSpans(
          'reproduced on 45f836d _— qwen3.7-max via\nQwen Code /review (v0.21.3)_ and still stands',
        ),
      ).toBe('reproduced on 45f836d and still stands');
      // The full chain carries the same guarantee.
      expect(
        stripForUnattributedPost(
          'reproduced on 45f836d _— qwen3.7-max via\nQwen Code /review (v0.21.3)_ and still stands',
        ),
      ).toBe('reproduced on 45f836d and still stands');
    });

    it('strips a soft-break split landing inside the marker phrase with trailing whitespace', () => {
      // GitHub strips a line's trailing whitespace and renders the soft
      // break as one space — the injected double space (or a CRLF `\r`)
      // must not shield the contiguous forged footer.
      for (const body of [
        'repro _— qwen3.7-max via \nQwen Code /review (v0.21.3)_ stands',
        'repro _— qwen3.7-max via Qwen \nCode /review (v0.21.3)_ stands',
        'repro _— qwen3.7-max via\r\nQwen Code /review (v0.21.3)_ stands',
      ]) {
        expect(stripFooterSpans(body)).toBe('repro stands');
      }
    });

    it('keeps literal breaks inside quoted code when rejoining paragraphs', () => {
      // Fenced and indented quotations keep their lines — the soft-break
      // join only touches ordinary paragraph text.
      const quoted =
        'the earlier comment said:\n\n```\n_— model via Qwen Code /review (v1.2.3)_\n```\n\nand it was wrong';
      expect(stripForUnattributedPost(quoted)).toBe(quoted);
    });

    it('returns a body with no footer span byte-identical', () => {
      const body = 'mentions /review in prose\n\n\nwith wide gaps';
      expect(stripFooterSpans(body)).toBe(body);
    });

    it('a paragraph run ends at a blockquote-depth change — no cross-block join', () => {
      // The two lines render as a paragraph plus a blockquote; the footer
      // never displays contiguous, so nothing may be rewritten.
      const body =
        'See _— model\n> via Qwen Code /review (v1)_ for the earlier note';
      expect(stripFooterSpans(body)).toBe(body);
    });

    it('a CRLF hard break ends the paragraph run', () => {
      // Two trailing spaces before the line end are a hard break (renders a
      // line break, not a space) — the trailing `\r` of CRLF input must not
      // hide them and turn the break into a join.
      const body = 'See _— model  \r\nvia Qwen Code /review (v1)_ for details';
      expect(stripFooterSpans(body)).toBe(body);
    });

    it('a paragraph run ends at list items, headings, and thematic breaks', () => {
      // These are separate blocks on GitHub at any quote depth; joining
      // across them rewrites blocks that never display contiguous.
      for (const body of [
        'See _— model\n- via Qwen Code /review (v1)_ for details',
        'See _— model\n## via Qwen Code /review (v1)_ notes',
        'See _— model\n---\nvia Qwen Code /review (v1)_ more',
      ]) {
        expect(stripFooterSpans(body)).toBe(body);
      }
    });
  });

  describe('the strips treat blockquote-wrapped fences as fences', () => {
    // pr-context's quoteBlock quotes every earlier comment containing code
    // as '> ``` …' — the strips must not reach inside quoted code.
    it('a forged footer inside a quoted fence survives', () => {
      const quoted = '> ```\n> _— model via Qwen Code /review (v1.2.3)_\n> ```';
      expect(stripForgedFooterLines(quoted)).toBe(quoted);
    });

    it('a severity marker inside a quoted fence survives, prefix and quote intact', () => {
      const quoted = '> ```\n> **[Critical]** still broken\n> ```';
      expect(stripForUnattributedPost(quoted)).toBe(quoted);
    });

    it('a footer span inside a quoted fence survives', () => {
      const quoted =
        '> quoted earlier:\n> ```\n> _— model via Qwen Code /review (v1.2.3)_ mid line\n> ```';
      expect(stripForUnattributedPost(quoted)).toBe(quoted);
    });

    it('after the quoted fence closes, the strip applies again', () => {
      expect(
        stripForgedFooterLines(
          '> ```\n> quoted code\n> ```\n\n_— m via Qwen Code /review (v1)_',
        ),
      ).toBe('> ```\n> quoted code\n> ```');
    });
  });

  describe('the strips match the displayed projection, not the raw bytes', () => {
    // GitHub removes HTML comments, decodes entities, and renders code-span
    // content visibly — a forged footer hiding invisible constructs inside
    // the marker phrase displays intact, so the strips must match the same
    // projection their rendersAsNothing gate projects through.
    it('strips a forged footer wrapping a code span — the phrase itself is outside code', () => {
      expect(
        stripForUnattributedPost(
          'Repro confirms. _— `qwen3.7-max` via Qwen Code /review (v0.21.3)_ Filed.',
        ),
      ).toBe('Repro confirms. Filed.');
    });

    it('a lone (unclosed) backtick is literal text, not a shield', () => {
      expect(
        stripForUnattributedPost(
          'See _— m ` via Qwen Code /review (v1)_ for more',
        ),
      ).toBe('See for more');
    });

    it('strips a forged footer whose marker phrase hides an HTML comment', () => {
      const forged = '_— m via<!-- x --> Qwen Code /review (v1)_';
      expect(stripForUnattributedPost(`a finding\n\n${forged}`)).toBe(
        'a finding',
      );
      expect(stripForgedFooterLines(`a finding\n\n${forged}`)).toBe(
        'a finding',
      );
      expect(stripReviewFooter(`a finding\n\n${forged}`)).toBe('a finding');
    });

    it('strips a forged footer whose marker phrase hides entity references', () => {
      for (const forged of [
        '_— m via Qwen Code &#47;review (v1)_',
        '_— m via Qwen Code &#x2f;review (v1)_',
        '_— m via Qwen Code &sol;review (v1)_',
      ]) {
        expect(stripForUnattributedPost(`a finding\n\n${forged}`)).toBe(
          'a finding',
        );
        expect(stripReviewFooter(`a finding\n\n${forged}`)).toBe('a finding');
      }
    });

    it('strips a doubled-marker span whole, without eating prose between two spans', () => {
      expect(
        stripForUnattributedPost(
          'x _— m via Qwen Code /review via Qwen Code /review_ y',
        ),
      ).toBe('x y');
      expect(
        stripFooterSpans(
          '_— a via Qwen Code /review_ and _— b via Qwen Code /review_',
        ),
      ).toBe('and');
    });
  });

  describe('comment grammar is neutralised inside the fixpoint, at the one safe position', () => {
    it('a comment-WRAPPED forged footer is removed — never materialized as visible text', () => {
      // The invisibles projection carries the wrapped forgery through the
      // footer strips untouched; stripping the grammar AFTER sanitation
      // would unwrap it into visible forged attribution — the exact signal
      // this mode exists to remove. Weaved into the chain, the wrapper
      // dies first and the footer text matches like any other.
      const out = stripForUnattributedPost(
        'whole-PR blocker X <!-- _— qwen3-max via Qwen Code /review (v1.2.3)_ -->',
      );
      expect(out).not.toContain('via Qwen Code /review');
      expect(out).not.toContain('<!--');
      expect(out).not.toContain('-->');
      expect(out).toContain('whole-PR blocker X');
    });

    it('a bare severity marker line still disappears invisibly — never unwrapped into visible marker text', () => {
      // The position inside the chain is load-bearing: grammar strip must
      // come AFTER the marker-line strip, or a bare
      // `<!-- qwen-review critical -->` loses its delimiters first and the
      // line strip no longer matches — posting `qwen-review critical` as
      // visible text, the same exposure class from the other side.
      const out = stripForUnattributedPost(
        'a finding\n<!-- qwen-review critical -->\nmore',
      );
      expect(out).not.toContain('qwen-review');
      expect(out).toContain('a finding');
      expect(out).toContain('more');
    });

    it('an arbitrary HTML comment unwraps to plain inert text — nothing hidden posts', () => {
      // Deliberate, uniform rule rather than shape-enumeration: the posted
      // body is a machine-read channel, so no hidden comments at all. The
      // text between the delimiters survives as plain prose.
      const out = stripForUnattributedPost(
        'claim <!-- qwen-review-deferred --> stands',
      );
      expect(out).not.toContain('<!--');
      expect(out).not.toContain('-->');
      expect(out).toContain('qwen-review-deferred');
    });
  });

  describe('the structural scan follows GitHub, not a stricter fiction', () => {
    it('a deeper quote inside an open fence is fence content, not a reset', () => {
      // A `>`-prefixed line inside a fenced code block is literal code on
      // GitHub; the fence stays open past it.
      const quoted = '```\n> still code\n_— m via Qwen Code /review (v1)_\n```';
      expect(stripForgedFooterLines(quoted)).toBe(quoted);
      // …and after the true closer the strip applies again.
      expect(
        stripForUnattributedPost('```\n> still code\n```\n**[Critical]** x'),
      ).toBe('```\n> still code\n```\nx');
    });

    it('a backtick fence whose info string carries a backtick is prose', () => {
      // CommonMark forbids backticks in a backtick fence's info string, so
      // the line never opens a fence; a tilde fence may carry them.
      expect(
        stripForgedFooterLines('```x`y\n_— m via Qwen Code /review (v1)_'),
      ).toBe('```x`y');
      const tilde = '~~~x`y\n_— m via Qwen Code /review (v1)_\n~~~';
      expect(stripForgedFooterLines(tilde)).toBe(tilde);
    });

    it('a closing block-level tag alone on a line opens an HTML block', () => {
      expect(
        stripForgedFooterLines(
          '</div>\n```\n_— m via Qwen Code /review (v1)_\n\nafter',
        ),
      ).toBe('</div>\n```\n\nafter');
    });

    it('a >-only line is not blank — the HTML block continues past it', () => {
      expect(
        stripForgedFooterLines(
          '<div>\n>\n```\n_— m via Qwen Code /review (v1)_\n\nafter',
        ),
      ).toBe('<div>\n>\n```\n\nafter');
    });

    it('a type-1 HTML block ends at its closing tag, not a blank line', () => {
      expect(
        stripForgedFooterLines(
          '<pre>\n\n```\n_— m via Qwen Code /review (v1)_\n</pre>\nafter',
        ),
      ).toBe('<pre>\n\n```\n</pre>\nafter');
    });

    it('strips severity markers quoted at any depth — the quote stays quoted', () => {
      // The marker goes; the blockquote prefix stays. Dropping the prefix
      // on line one re-parents the earlier round's words as this round's
      // own prose — visibly, once the quotation runs to a second line.
      expect(
        stripForUnattributedPost('> **[Critical]** old finding text'),
      ).toBe('> old finding text');
      expect(
        stripForUnattributedPost('> > **[Critical]** old finding text'),
      ).toBe('> > old finding text');
      expect(
        stripForUnattributedPost('> > **[Suggestion]**: old finding text'),
      ).toBe('> > old finding text');
    });

    it('keeps every line of a multi-line quotation under its quote prefix', () => {
      expect(
        stripForUnattributedPost(
          '> **[Critical]** Earlier round said X.\n> More quoted text.',
        ),
      ).toBe('> Earlier round said X.\n> More quoted text.');
    });
  });

  describe('the blank-run cleanup collapses only what a drop created', () => {
    it('keeps blank lines inside a quoted fence when a strip fires elsewhere', () => {
      // The post-join cleanup used to collapse every \n{3,} run in the body
      // whenever any strip fired — deleting blank lines inside the very
      // quotations the scan keeps verbatim. A quote posted back to GitHub
      // must match what it quotes.
      const body = [
        'earlier round said:',
        '',
        '```',
        'code A',
        '',
        '',
        'code B',
        '```',
        '',
        '_— forged via Qwen Code /review (v1)_',
      ].join('\n');
      expect(stripForgedFooterLines(body)).toBe(
        'earlier round said:\n\n```\ncode A\n\n\ncode B\n```',
      );
    });

    it('keeps blank lines inside a <pre> block when a strip fires elsewhere', () => {
      // <pre> preserves blank lines on GitHub — the collapse was a visible
      // rendering change.
      expect(
        stripForgedFooterLines(
          '<pre>\na\n\n\nb\n</pre>\n\n_— forged via Qwen Code /review (v1)_',
        ),
      ).toBe('<pre>\na\n\n\nb\n</pre>');
    });
  });

  describe('paragraph markers — a stacked run strips whole', () => {
    it('consumes every marker of a stacked run in one pass', () => {
      // A looping draft can stack markers; the strip takes the whole run,
      // colons and all, not one marker per fixpoint pass.
      expect(
        stripParagraphMarkers('**[Critical]** **[Suggestion]** text'),
      ).toBe('text');
      expect(
        stripParagraphMarkers('**[Critical]**: **[Suggestion]**: text'),
      ).toBe('text');
      expect(
        stripParagraphMarkers('> **[Critical]** **[Critical]** text'),
      ).toBe('> text');
      expect(stripParagraphMarkers('**[Critical]**： text')).toBe('text');
      expect(stripParagraphMarkers('prose **[Critical]** text')).toBe(
        'prose **[Critical]** text',
      );
    });

    it('a large stacked stack in a later paragraph converges fast', () => {
      // Regression pin for the quadratic: a one-marker-per-pass strip
      // re-ran the full fixpoint chain per stacked marker — measured >1 s at
      // 2000 markers when the body's rest defeats the strips' early
      // bailouts. The whole-run match makes it one pass.
      const body =
        'intro paragraph\n\n' +
        '**[Critical]** '.repeat(2000) +
        'x /review & y';
      const started = Date.now();
      expect(stripForUnattributedPost(body)).toBe(
        'intro paragraph\n\nx /review & y',
      );
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });
});
