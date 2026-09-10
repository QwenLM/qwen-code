/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  stripReviewFooterLine,
  swallowsAppendedMarker,
  FIXED_RULING_SHAPE_RE,
  FIXED_RULING_MARKER,
  FOOTER_MARKER,
} from './review-footer.js';
import { CANONICAL_LGTM_RE } from '../pr-context.js';
import { expectWithinLatencyBudget } from '../../../test-utils/latency-budget.js';

const RULING_CORPUS = [
  // What `submit` posts: `${fixedRulingLine(id, by)} ${MARKER}`, with the
  // attribution footer appended under attribution on.
  ['R1-2 fixed by the guard rewrite <!-- qwen-review-fixed-ruling -->', true],
  ['R1-2 fixed <!-- qwen-review-fixed-ruling -->', true],
  [
    'R01-2 fixed by x <!-- qwen-review-fixed-ruling -->\n\n_— m via Qwen Code /review (v0.21.3)_',
    true,
  ],
  [
    'R123-456 fixed by the retry; the old path still fails <!-- qwen-review-fixed-ruling -->\r\n\r\n_— m via Qwen Code /review (v1)_',
    true,
  ],
  // A Critical that QUOTES the note — the shape must end at the marker,
  // or such a finding demotes itself out of the blocker re-check.
  [
    'R1-2 fixed by the guard <!-- qwen-review-fixed-ruling --> is the shape this filter matches, and it is anchored',
    false,
  ],
  [
    '**[Critical]** R3-1: the filter `<!-- qwen-review-fixed-ruling -->` is substring-anywhere',
    false,
  ],
  [
    'a note that merely mentions <!-- qwen-review-fixed-ruling --> mid-body',
    false,
  ],
  // GitHub hands a body back with its trailing newline; jq's `$` matches
  // before one and JS's does not, so the `\s*` before the anchor is what
  // keeps the two dialects reading the same note (#9940 review, round 31
  // reverse audit).
  ['R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n', true],
  ['R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\r\n', true],
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n\n_— m via Qwen Code /review (v1)_\r\n',
    true,
  ],
  // A `by` carrying a line break of ANY kind is not a bare note. jq's
  // `[^\n]` admits `\r`/U+2028/U+2029 and JS's `.` does not, so the census
  // dropped comments this side counted until both named the same breaks
  // (#9940 review, round 31 reverse audit).
  ['R1-2 fixed by x\rEXTRA <!-- qwen-review-fixed-ruling -->', false],
  ['R1-2 fixed by x\u2028EXTRA <!-- qwen-review-fixed-ruling -->', false],
  ['R1-2 fixed by x\u2029EXTRA <!-- qwen-review-fixed-ruling -->', false],
  ['R1-2 fixed by x EXTRA <!-- qwen-review-fixed-ruling -->', true],
  // `\s` is not one set: Oniguruma matches U+0085 and JS does not; JS
  // matches U+FEFF and Oniguruma does not. Both engines must read these
  // the same way, or the census drops a comment this side counts (#9940
  // review, round 31 reverse audit).
  ['R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\u0085', false],
  ['R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\ufeff', false],
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n\u0085_— m via Qwen Code /review (v1)_',
    false,
  ],
  // …and the gap before the footer is the same story the other way round:
  // JS `\s` matches U+00A0, Oniguruma's does not.
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n\u00a0_— m via Qwen Code /review (v1)_',
    false,
  ],
  ['R1-2 fixed by x', false],
  ['  R1-2 fixed by x <!-- qwen-review-fixed-ruling -->', false],
  // A comment that quotes the note in FULL on its first line and then
  // states its own finding underneath — the natural way to say "this was
  // ruled fixed last round and is not". Anchoring the note's LINE let the
  // census drop that whole comment, the live Critical with it (#9940
  // review, round 31).
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n\n**[Critical]** R3-4: the census drops this whole comment',
    false,
  ],
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n\n_— m via Qwen Code /review (v1)_\n\nand then some prose',
    false,
  ],
  // The tail after the marker is the CANONICAL footer, not "any italic
  // line": a comment whose own second paragraph is italic prose read as a
  // note and left the census with the Critical inside it (#9940 review,
  // round 31 reverse audit).
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n\n_— **[Critical]** R3-4: the auth check is still missing_',
    false,
  ],
  // The footer's model segment names the SAME line breaks the `by` clause
  // does. Spelled `[^\n]` it admitted `\r`, U+2028 and U+2029, so a
  // "footer" carrying a live finding on a second display line read as a
  // note in both dialects and the census dropped the comment (#9940
  // review, round 31 reverse audit).
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n_— m\rSTILL OPEN: the auth check via Qwen Code /review_',
    false,
  ],
  [
    'R1-2 fixed by x <!-- qwen-review-fixed-ruling -->\n_— m\u2028STILL OPEN: the auth check via Qwen Code /review_',
    false,
  ],
  // Built by the real writer from a modelId the writer's own guard used to
  // admit: U+2028 and U+2029 are display line breaks the readers' footer
  // tail names, so the note the bot posts has to be one its own matcher
  // accepts (#9940 review, round 31 reverse audit).
  [
    `R1-2 fixed by the guard rewrite <!-- qwen-review-fixed-ruling -->\n\n${'_— a\u2028b via Qwen Code /review (v1)_'}`,
    false,
  ],
  // A run of horizontal whitespace after the marker is still a note; it
  // is decided in bounded time (see the overlap cell below).
  ['R1-2 fixed by x <!-- qwen-review-fixed-ruling -->   \t  ', true],
  ['R1-2 fixed by x <!-- qwen-review-fixed-ruling -->  \n\t \n ', true],
] as const;

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
    // The writer's gate and the readers' class are ONE set: U+2028 and
    // U+2029 are display line breaks the footer tail names, so a modelId
    // carrying one builds a canonical ruling note that neither this
    // module's matcher nor the autofix census accepts — the note is
    // re-posted every round (#9940 review, round 31 reverse audit).
    for (const modelId of ['a\u2028b', 'a\u2029b', 'a\rb', 'a\nb']) {
      expect([modelId, isFooterSafeModelId(modelId)]).toEqual([modelId, false]);
      expect(
        FIXED_RULING_SHAPE_RE.test(
          `R1-2 fixed by x ${FIXED_RULING_MARKER}\n\n${reviewFooter(modelId, '1')}`,
        ),
      ).toBe(false);
    }
    // …and one the gate admits builds a note the matcher accepts.
    for (const modelId of ['qwen3.7-max', 'a\u0085b', 'a\tb', 'a b']) {
      expect([modelId, isFooterSafeModelId(modelId)]).toEqual([modelId, true]);
      expect(
        FIXED_RULING_SHAPE_RE.test(
          `R1-2 fixed by x ${FIXED_RULING_MARKER}\n\n${reviewFooter(modelId, '1')}`,
        ),
      ).toBe(true);
    }
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

  it('drops a version slot the readers cannot parse — a canonical note stays recognisable (#9940 review, round 31 reverse audit)', () => {
    // `footerVersion` gates the startup stamp, but the fallback
    // (`CLI_VERSION`, else the package version) reached `reviewFooter`
    // unchecked: a version carrying a space or a paren built a note the
    // ruling-shape matcher does not recognise, so the lifecycle re-posts
    // it every round.
    for (const version of [
      '0.1.0 (nightly)',
      // A space alone is enough — the readers' version class does not
      // admit one, and every other row here fails on a paren, a newline
      // or emptiness instead (#9940 review, round 31 reverse audit).
      '0.1.0 nightly',
      '1.0\n2.0',
      '0.21.3)evil',
      '',
    ]) {
      const footer = reviewFooter('qwen3-max', version);
      expect(footer).toBe(`_— qwen3-max ${FOOTER_MARKER}_`);
      expect(`a finding\n\n${footer}`.replace(REVIEW_FOOTER_RE, '')).toBe(
        'a finding',
      );
      expect(
        FIXED_RULING_SHAPE_RE.test(
          `R1-2 fixed by the guard rewrite ${FIXED_RULING_MARKER}\n\n${footer}`,
        ),
      ).toBe(true);
    }
    // A version the charset accepts is still carried, capped and all.
    expect(
      FIXED_RULING_SHAPE_RE.test(
        `R1-2 fixed by x ${FIXED_RULING_MARKER}\n\n${reviewFooter('m', 'v'.repeat(65_200))}`,
      ),
    ).toBe(true);
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
      expectWithinLatencyBudget(performance.now() - start, 2000, {
        poolMultiplier: 10,
      });
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
      expectWithinLatencyBudget(performance.now() - start, 2000, {
        poolMultiplier: 10,
      });
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

    it('an unterminated comment opener quoted in code does not blind the strip', () => {
      // A witness block quoting an HTML marker cut short — what a review of
      // a dedup marker posts — leaves a `<!--` with no `-->` in the body.
      // Projected, that opener runs to the END of the input and takes the
      // trailing footer with it, so the strip saw no footer, left the
      // model's own, and the canonical one posted beside it as a second
      // attribution line. Inside a fence the opener is literal text on
      // GitHub and both footers render.
      const witness = 'Witness:\n```\njq: error … ("<!-- ecs-f…") cannot\n```';
      expect(
        stripReviewFooter(`${witness}\n\n_— m via Qwen Code /review_`),
      ).toBe(witness);
    });

    it('a footer inside code is a quotation, not a trailing footer', () => {
      // The same blanking, in the direction the other strips already take:
      // code content is a quotation, so a footer inside an unclosed fence
      // or an indented block is not the attribution this strip removes.
      for (const quoted of [
        '```\n_— m via Qwen Code /review (v1)_',
        'a finding\n\n    _— m via Qwen Code /review (v1)_',
      ]) {
        expect(stripReviewFooter(quoted)).toBe(quoted);
      }
    });

    it('an unterminated opener in a fence info string does not blind the strip', () => {
      // GitHub renders neither the fence delimiters nor an opener's info
      // string, so the delimiters blank with the content: a `<!--` lodged
      // in the info string would otherwise stay in the projection, run to
      // the end of the input, and hide the trailing footer.
      expect(
        stripReviewFooter(
          '```js <!--\ncode\n```\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('```js <!--\ncode\n```');
      expect(
        stripReviewFooter(
          '~~~js <!--\ncode\n~~~\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('~~~js <!--\ncode\n~~~');
    });

    it('classifies code versus prose with a CommonMark parser, not a hand model', () => {
      // An indented code block cannot interrupt a paragraph, so a 4-space
      // line right after a paragraph line is a lazy continuation GitHub
      // renders visibly; inside a list item the code threshold sits at the
      // item's content indent; a leading tab is the 4-column stop and IS
      // code. A hand-built scan read the first two as code (blanking them
      // kept the forged footer) and the tab as prose (an unterminated
      // `<!--` quoted in it then blinded the strip).
      expect(
        stripReviewFooter('a finding\n    _— m via Qwen Code /review_'),
      ).toBe('a finding');
      expect(stripReviewFooter('- item\n    _— m via Qwen Code /review_')).toBe(
        '- item',
      );
      expect(
        stripReviewFooter('1. finding\n\n    _— m via Qwen Code /review (v1)_'),
      ).toBe('1. finding');
      expect(
        stripReviewFooter('> finding\n    _— m via Qwen Code /review_'),
      ).toBe('> finding');
      expect(
        stripReviewFooter('-   item\n\n      _— m via Qwen Code /review_'),
      ).toBe('-   item');
      expect(
        stripReviewFooter(
          '- item\n\n  > quoted\n\n    _— m via Qwen Code /review_',
        ),
      ).toBe('- item\n\n  > quoted');
      expect(
        stripReviewFooter('para\n- item\n\n _— m via Qwen Code /review_'),
      ).toBe('para\n- item');
      expect(
        stripReviewFooter('finding\n===\n\n_— m via Qwen Code /review_'),
      ).toBe('finding\n===');
      expect(
        stripReviewFooter(
          '- x\n ```\n code\n ```\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('- x\n ```\n code\n ```');
      const tabQuoted = 'a finding\n\n\t_— m via Qwen Code /review_';
      expect(stripReviewFooter(tabQuoted)).toBe(tabQuoted);
      expect(
        stripReviewFooter('a finding\n\n\t<!--\n\n_— m via Qwen Code /review_'),
      ).toBe('a finding\n\n\t<!--');
      // A >= 4-column `<div>` line is indented code, not an HTML block.
      expect(
        stripReviewFooter(
          'x\n\n    <div>\n    <!-- y\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('x\n\n    <div>\n    <!-- y');
    });

    it('pins the keep side of the classifier — breaks, headings, and the list code threshold', () => {
      // A heading or thematic break interrupts a paragraph, so a 4-space
      // footer line after one is an indented code block the strip keeps,
      // and inside a list item the code threshold rises by the item's
      // content indent. Unpinned, a dropped check would silently delete
      // footer lines GitHub renders as code.
      const keep = (body: string): void => {
        expect(stripReviewFooter(body)).toBe(body);
      };
      keep('a finding\n---\n    _— m via Qwen Code /review_');
      keep('# h\n    _— m via Qwen Code /review_');
      keep('a finding\n## h\n    _— m via Qwen Code /review_');
      keep('- item\n\n        _— m via Qwen Code /review_');
      keep('- item\n# h\n\n    _— m via Qwen Code /review (v1)_');
    });

    it('a comment closer quoted in a raw-HTML block still closes the projected comment', () => {
      // The dual of the hole the blanking fixes: a line-leading `<!--`
      // opens a CommonMark comment block that runs to the line holding
      // `-->` — a fence delimiter inside it is block content, not a fence.
      // The parser sees that; a hand scan read the delimiter as opening a
      // fence, blanked the closer line, and the opener then ran to the end
      // of the input and kept the real trailing footer. The PI and CDATA
      // twins hold their lines the same way, and the comment renders
      // nothing, so the cut may span it.
      expect(
        stripReviewFooter('<!--\n```\n-->\n\n_— m via Qwen Code /review_'),
      ).toBe('<!--\n```\n-->');
      expect(
        stripReviewFooter('<!--\n    -->\n\n_— m via Qwen Code /review_'),
      ).toBe('<!--\n    -->');
      expect(
        stripReviewFooter('<!--\n```x -->\n_— m via Qwen Code /review_'),
      ).toBe('<!--\n```x -->');
      expect(
        stripReviewFooter('<?\n```x ?>\n_— m via Qwen Code /review_'),
      ).toBe('<?\n```x ?>');
      expect(
        stripReviewFooter('<![CDATA[\n```x ]]>\n_— m via Qwen Code /review_'),
      ).toBe('<![CDATA[\n```x ]]>');
      expect(
        stripReviewFooter(
          '[Suggestion] tidy\n<!--\n```x -->\n_— forged via Qwen Code /review_',
        ),
      ).toBe('[Suggestion] tidy');
    });

    it('a dangling opener after the trailing footer does not break the anchor', () => {
      // A looping model truncates a forged footer mid-character and a
      // dangling `<!--` can ride the footer's own line or a later one. The
      // projection swallows an unclosed opener to the end of the input, so
      // nothing visible follows the footer and the `$` anchor holds — the
      // attribution-off anywhere strip reads the same projection.
      expect(stripReviewFooter('x\n\n_— m via Qwen Code /review_ <!--')).toBe(
        'x',
      );
      expect(stripReviewFooter('x\n\n_— m via Qwen Code /review_\n<!--')).toBe(
        'x',
      );
      expect(stripForgedFooterLines('_— m via Qwen Code /review_ <!--')).toBe(
        '',
      );
    });

    it('blanks from the body start, not the tail — a fence straddling the tail bound keeps its state', () => {
      // The blanking scans from the body's START: a fence opened before
      // the STRIP_TAIL_LIMIT tail window keeps its state across the
      // boundary. A tail-only scan would read the quoted code as ordinary
      // text and the unblanked opener would swallow the trailing footer —
      // the fixture must exceed the bound with the fence opening ahead of
      // it and the comment's opener inside it.
      const fillerA = 'a'.repeat(4000);
      const fillerB = 'b'.repeat(4500);
      const quoted =
        'W:\n```\n' + fillerA + '\n<!--\n' + fillerB + '\n-->\n```';
      const body = quoted + '\n\n_— m via Qwen Code /review_';
      expect(body.length).toBeGreaterThan(8192);
      expect(stripReviewFooter(body)).toBe(quoted);
    });

    it('keeps CRLF and bare-CR endings byte-identical when it strips', () => {
      // The blanking reattaches each line's own ending and the cut slices
      // the ORIGINAL bytes — unlike the sibling strips, which normalize
      // CRLF to LF on the rejoin. Both a fenced and an indented quotation
      // must survive the blanking's length arithmetic under CRLF and bare
      // CR alike.
      expect(
        stripReviewFooter(
          'a finding\r\n\r\n```\r\ncode\r\n```\r\n\r\n_— m via Qwen Code /review_',
        ),
      ).toBe('a finding\r\n\r\n```\r\ncode\r\n```');
      expect(
        stripReviewFooter(
          'a finding\r\r    code\r\r_— m via Qwen Code /review_',
        ),
      ).toBe('a finding\r\r    code');
    });

    it('a comment splitting the marker phrase is seen through — the `<` gate admits it', () => {
      // The projection drops a closed comment whole, so the halves of the
      // phrase display rejoined; the body carries neither a literal
      // `/review` nor an `&`, and only the `<` arm of the gate lets it
      // reach the projection at all.
      expect(
        stripReviewFooter('finding\n\n_— m via Qwen Code /<!-- x -->review_'),
      ).toBe('finding');
      expect(
        stripReviewFooter('finding\n\n_— m via Qwen Code /rev<!-- x -->iew_'),
      ).toBe('finding');
    });

    it('the block-only parse stays cheap on a hostile one-line body', () => {
      // The blanking parses the WHOLE body (a fence's state is only
      // knowable from where it opened), so the parse must stay block-only:
      // with markdown-it's inline pass on, a 256 KiB run of `[` measured
      // ~400 ms against ~1 ms with it off. The bound is the property under
      // test — an output assertion alone cannot see the guard.
      const run = '['.repeat(4 * 65536);
      const start = performance.now();
      expect(stripReviewFooter(`${run}\n\n_— m via Qwen Code /review_`)).toBe(
        run,
      );
      expectWithinLatencyBudget(performance.now() - start, 40, {
        poolMultiplier: 5,
      });
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
      expectWithinLatencyBudget(performance.now() - start, 1000, {
        poolMultiplier: 5,
      });
    }, 20_000);
  });

  describe("stripReviewFooterLine — the one-line channels' shape", () => {
    it('an unterminated comment opener on the folded line is literal text, not a swallow', () => {
      // A folded line is one paragraph with no later line for a closer to
      // sit on, so CommonMark's inline HTML rule never fires: GitHub escapes
      // the opener and renders the forged footer after it as prose. The
      // fold puts a witness block's quoted `<!--` on the footer's own line
      // — the trigger this strip exists for, arriving through the one-line
      // channels. A `~~~` or unclosed fence and an indented block fold to
      // this shape; a ``` run does not, because the projection masks it as
      // a code span.
      expect(
        stripReviewFooterLine('x ~~~ <!-- x ~~~ _— m via Qwen Code /review_'),
      ).toBe('x ~~~ <!-- x ~~~');
      expect(
        stripReviewFooterLine('x <!-- x _— m via Qwen Code /review_'),
      ).toBe('x <!-- x');
      // A closed comment still drops whole: a footer after it strips, one
      // inside it is invisible either way.
      expect(
        stripReviewFooterLine('x <!-- hidden --> _— m via Qwen Code /review_'),
      ).toBe('x');
      const hidden = 'x <!-- _— m via Qwen Code /review_ -->';
      expect(stripReviewFooterLine(hidden)).toBe(hidden);
      // The multi-line strip keeps the aggressive reading: a line-leading
      // opener opens a comment block running to the end of the input, and
      // the footer inside it renders as nothing.
      const swallowed = 'x\n<!-- y\n_— m via Qwen Code /review_';
      expect(stripReviewFooter(swallowed)).toBe(swallowed);
    });

    it('strips a trailing footer a folded line carries — a single line is no block quotation', () => {
      // The one-line channels (folded deferral titles, reroute records,
      // relocated claims, ingested entries) flatten every code shape
      // before they post, so the blanking the multi-line strip applies
      // cannot keep a footer here: a fence delimiter leading the line is
      // posted text, and the forged attribution must not ride it.
      expect(
        stripReviewFooterLine('tidy ``` _— m via Qwen Code /review_'),
      ).toBe('tidy ```');
      expect(stripReviewFooterLine('``` _— m via Qwen Code /review_')).toBe(
        '```',
      );
      expect(
        stripReviewFooterLine('    finding _— m via Qwen Code /review_'),
      ).toBe('    finding');
    });

    it('keeps a footer an inline code span quotes on the line', () => {
      // Inline code renders visibly — the projection masks it, so a
      // quoted footer stays while a forged one outside the span strips.
      const quoted = 'see `_— m via Qwen Code /review_` quoted above';
      expect(stripReviewFooterLine(quoted)).toBe(quoted);
      expect(
        stripReviewFooterLine('x `code` _— m via Qwen Code /review_'),
      ).toBe('x `code`');
    });
  });

  describe('stripForgedFooterLines — the attribution-off anywhere strip', () => {
    it('classifies through the CommonMark parser like the trailing strip', () => {
      // The line-aware strips read the same token map as the blanking: a
      // fence inside an open list item measures its indent against the
      // item's content indent (the quoted footer stays), a setext
      // underline ends the paragraph (the 4-space line after it is a code
      // block the strip keeps), and the item's content indent is the
      // ACTUAL whitespace after the marker — two tabs past a 5-column
      // indent is item prose, not code.
      const fenceInList =
        '- item\n\n    ```\n    _— m via Qwen Code /review_\n    ```\n\nmore';
      expect(stripForUnattributedPost(fenceInList)).toBe(fenceInList);
      const setext = 'para\n===\n    _— m via Qwen Code /review_';
      expect(stripForUnattributedPost(setext)).toBe(setext);
      expect(
        stripForUnattributedPost(
          '-    para\n\n\t\t_— m via Qwen Code /review_',
        ),
      ).toBe('-    para');
    });

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

    it("the full chain leaves comment grammar alone — neutralizing it is the body exits' job", () => {
      // The chain is shared with submit's inline-comment transform, whose
      // pinned contract keeps a quoted marker MENTION verbatim (`posts
      // <!-- qwen-review suggestion --> verbatim` is text, not a bare
      // marker), and with the ledger's id read, which steps over a
      // leading comment as render-nothing residue. Weaving the grammar
      // strip in here broke both: the mention posted as visible words and
      // the residue became prose ahead of the carried id. The body exits
      // neutralize before they call this chain (`quotedProse` in
      // compose-review), so a comment-wrapped forged footer still strips
      // there — without the inline channel paying for it.
      const mention =
        'the sample posts <!-- qwen-review suggestion --> verbatim';
      expect(stripForUnattributedPost(mention)).toBe(mention);
      const wrapped =
        'blocker <!-- _— m via Qwen Code /review (v1)_ --> stands';
      expect(stripForUnattributedPost(wrapped)).toBe(wrapped);
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
        '[label]: /url',
      ]) {
        expect(rendersAsNothing(scaffold)).toBe(true);
      }
    });

    it('decides a run of unterminated openers in bounded time (#9940 review, round 31 reverse audit)', () => {
      // The `<!` family is taken as ONE left-to-right SCAN, not a regex
      // alternation: with no end-of-input alternative the alternation
      // retries at every later `<`, and this projection runs twice per
      // entry and once per inline comment body, on text a model writes with
      // no length bound. Measured 19 s on the first of these before the
      // scan.
      for (const text of [
        '<![CDATA['.repeat(80000),
        '<!--'.repeat(80000),
        '<?'.repeat(80000),
        '<!A '.repeat(80000),
      ]) {
        const t0 = Date.now();
        rendersAsNothing(text);
        expectWithinLatencyBudget(Date.now() - t0, 1000, {
          poolMultiplier: 20,
        });
      }
    });

    it('decides an entity reference by what it decodes to, and reads its case (#9940 review, round 31 reverse audit)', () => {
      // A hand list named ten of the thirty-three invisible HTML5 names
      // and twelve of the numeric spellings, so a Critical of nothing but
      // `&Tab;` passed every gate and posted with no visible content —
      // counted toward the verdict, re-promoted as an unanswerable
      // blocker.
      for (const ref of [
        '&Tab;',
        '&NewLine;',
        '&NonBreakingSpace;',
        '&NoBreak;',
        '&MediumSpace;',
        '&ThinSpace;',
        '&ThickSpace;',
        '&VeryThinSpace;',
        '&NegativeThinSpace;',
        '&hairsp;',
        '&numsp;',
        '&puncsp;',
        '&emsp13;',
        '&emsp14;',
        '&af;',
        '&ic;',
        '&it;',
        '&ApplyFunction;',
        '&InvisibleTimes;',
        '&InvisibleComma;',
        '&ZeroWidthSpace;',
        '&nbsp;',
        '&#9;',
        '&#x9;',
        '&#10;',
        '&#xa;',
        '&#1564;',
        '&#5760;',
        '&#6158;',
        '&#8232;',
        '&#x2028;',
        '&#8233;',
        '&#x2029;',
        '&#8287;',
        '&#x205f;',
        '&#8289;',
        '&#8290;',
        '&#8291;',
        '&#12288;',
        '&#x3000;',
        // Controls are never glyphs, and the numeric bound is wider than
        // CommonMark's because cmark-gfm decodes past it.
        '&#28;',
        '&#31;',
        '&#133;',
        '&#00000160;',
        '&#x00000a0;',
      ]) {
        expect([ref, rendersAsNothing(ref)]).toEqual([ref, true]);
      }
      // Named references are CASE-SENSITIVE — a reader sees the literal
      // `&NBSP;` — and matching case-insensitively read a visible body as
      // empty, which throws the compose away.
      for (const ref of [
        '&NBSP;',
        '&TAB;',
        '&AF;',
        '&IT;',
        '&nobreak;',
        '&notanentity;',
        '&#0;',
        '&#55296;',
        '&#x41;',
        '&#1114112;',
      ]) {
        expect([ref, rendersAsNothing(ref)]).toEqual([ref, false]);
      }
    });

    it('a `<!` construct hides only up to the first `>` — the prose behind one still counts (#9940 review, round 31 reverse audit)', () => {
      // The markdown block hands its raw text to an HTML parser, which
      // closes a bogus comment at the first `>` — and `<!-->`/`<!--->`
      // close on their own dashes. Reading either as running to `]]>` or
      // to the next `-->` deleted VISIBLE prose, and the callers of
      // `rendersAsNothingAtExit` throw the whole compose away on a body
      // this projection calls empty.
      for (const body of [
        '<![CDATA[ a > the auth check at line 40 is still missing ]]>',
        '<![CDATA[>the auth check at line 40 is still missing',
        '<!--> the auth check at line 40 is still missing',
        '<!---> the auth check at line 40 is still missing',
        '<!A y> the auth check at line 40 is still missing',
      ]) {
        expect([body, rendersAsNothing(body)]).toEqual([body, false]);
      }
      // …and with nothing behind the `>` they are still scaffolding.
      for (const body of [
        '<![CDATA[ x ]]>',
        '<![CDATA[ x',
        '<!-->',
        '<!--->',
        // An abrupt close with nothing behind it is still scaffolding.
        '<!-- a --!>',
        // …and a LINE-LEADING opener with no terminator really is an HTML
        // block that runs to the end of the document.
        '<!A the auth check at line 40 is missing',
        '<!DOCTYPE the auth check at line 40 is missing',
        '<![CDATA[the auth check at line 40 is missing',
        '<!--the auth check at line 40 is missing',
        '<?the auth check at line 40 is missing',
        '<?php echo 1 ?>',
      ]) {
        expect([body, rendersAsNothing(body)]).toEqual([body, true]);
      }
      // …and a comment ALSO closes at `--!>` (HTML5 comment-end-bang), so
      // the prose behind one is visible and the compose must not be thrown
      // away over it (#9940 review, round 10 reverse audit).
      expect(
        rendersAsNothing(
          '<!-- a --!> the auth check at line 40 is still missing',
        ),
      ).toBe(false);
      // A declaration is `<!` + UPPERCASE letters + WHITESPACE — cmark-gfm's
      // grammar, derived exhaustively — so `<!a …` is none of those and the
      // reader sees it and everything behind it. A processing instruction
      // hides only to the first `>`, not to its `?>`, for the same reason
      // the CDATA arm already does. And the four openers are ONE
      // left-to-right decision, because that is how the HTML tokenizer takes
      // it: read as four independent global passes, the comment pass ate the
      // `>` that terminates the declaration standing in FRONT of it. Each of
      // these threw the whole compose away over prose a reader can see
      // (#9940 review, round 11 reverse audit).
      for (const body of [
        '<!a the auth check at line 40 is missing',
        '<?x</b> the auth check at line 40 is missing',
        '<!A <!-->the auth check at line 40 is missing',
        '<!Ax> the auth check is missing',
        // `<!ax>` is not a declaration at all — cmark renders `&lt;!ax&gt;`,
        // so a reader sees it.
        '<!ax>',
        'q <!--the auth check at line 40 is missing',
        'q <![CDATA[the auth check at line 40 is missing',
        'q <?the auth check at line 40 is missing',
      ]) {
        expect([body, rendersAsNothing(body)]).toEqual([body, false]);
      }
    });

    it('still counts real content wearing the same shapes', () => {
      expect(rendersAsNothing('<div>real bug</div>')).toBe(false);
      // GFM's tagfilter — which GitHub runs — rewrites the opener to
      // `&lt;script`, so a reader SEES the tag and everything between the
      // tags. Deleting them read a visible body as empty, and a security
      // Critical that pastes its payload is exactly that shape: the whole
      // compose was thrown away over it (#9940 review, round 10 reverse
      // audit).
      expect(rendersAsNothing('<script>alert(1)</script>')).toBe(false);
      expect(rendersAsNothing('<style>a{}</style>')).toBe(false);
      expect(
        rendersAsNothing('<script>x</script> the auth check is missing'),
      ).toBe(false);
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
      // A comment/PI/declaration/CDATA block left open swallows the
      // appended marker to NOTHING — the exposure this gate refuses is a
      // marker that renders VISIBLE, so only the tag-based blocks (the
      // <pre> control above) count.
      expect(swallowsAppendedMarker('**[Critical]** x\n\n<!-- note')).toBe(
        false,
      );
      expect(swallowsAppendedMarker('**[Critical]** x\n\n<? note')).toBe(false);
      expect(swallowsAppendedMarker('**[Critical]** x\n\n<!DOCTYPE x')).toBe(
        false,
      );
      expect(swallowsAppendedMarker('**[Critical]** x\n\n<![CDATA[ note')).toBe(
        false,
      );
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

    it('a type-6 opener with trailing text opens an HTML block — the start condition ends at the tag name (#9940 review, round 27)', () => {
      expect(
        stripForgedFooterLines(
          '<div class="x">foo\n```\n_— m via Qwen Code /review (v1)_\n\nafter',
        ),
      ).toBe('<div class="x">foo\n```\n\nafter');
      // A type-1 block runs past a blank line to its closing tag.
      expect(
        stripForgedFooterLines(
          '<pre>foo\n\n```\n_— m via Qwen Code /review (v1)_\n</pre>\n\nafter',
        ),
      ).toBe('<pre>foo\n\n```\n</pre>\n\nafter');
      // A name that only starts with a block-level tag name is text.
      const text = '<divx>foo\n```\n_— m via Qwen Code /review (v1)_\n```';
      expect(stripForgedFooterLines(text)).toBe(text);
    });

    it('a type-1 block whose closing tag sits on the opener line ends there; `<pre-x>` is no type-1 tag (#9940 review, audit 4)', () => {
      expect(swallowsAppendedMarker('claim\n\n<pre>x</pre>\n\nmore')).toBe(
        false,
      );
      expect(
        swallowsAppendedMarker('claim\n\n<script>x</script>\n\nmore'),
      ).toBe(false);
      expect(
        stripForUnattributedPost(
          '<pre>x</pre>\n\nfoo _— a via Qwen\nCode /review_ bar',
        ),
      ).toBe('<pre>x</pre>\n\nfoo bar');
      // Still open when the closing tag is not on the line.
      expect(swallowsAppendedMarker('claim\n\n<pre>x\n\nmore')).toBe(true);
      expect(swallowsAppendedMarker('<pre-x>\n\nclaim')).toBe(false);
    });

    it('a tab-indented code line is code in the line model — its footer or marker text is quotation, kept (#9940 review, audit 4)', () => {
      const marker = 'claim\n\n\t<!-- qwen-review critical -->\n\tmore code';
      expect(stripCommentMarkerLines(marker)).toBe(marker);
      const footer = 'claim\n\n\t_— a via Qwen Code /review_\n\tmore code';
      expect(stripForgedFooterLines(footer)).toBe(footer);
      const mixed = 'claim\n\n  \t_— a via Qwen Code /review_\n  \tmore code';
      expect(stripForgedFooterLines(mixed)).toBe(mixed);
    });

    it('four columns is code before it is an opener or a fence — quotation kept, a real forged footer behind a tab-fence stripped (#9940 review, audit 5)', () => {
      const code = 'claim\n\n\t<div>\n    _— x via Qwen Code /review_ keep';
      expect(stripForUnattributedPost(`**[Critical]** ${code}`)).toBe(code);
      const fenced = '    <div>\n```\n_— x via Qwen Code /review_\n```';
      expect(stripForgedFooterLines(fenced)).toBe(fenced);
      expect(
        stripForgedFooterLines(
          'claim\n\n\t```\n_— x via Qwen Code /review_\nprose',
        ),
      ).toBe('claim\n\n\t```\nprose');
      // A single code-indented line is quotation — the span stays.
      expect(stripFooterSpans('    quoted _— x via Qwen Code /review_')).toBe(
        '    quoted _— x via Qwen Code /review_',
      );
      expect(stripFooterSpans('_— x via Qwen Code /review_ claim')).toBe(
        'claim',
      );
    });

    it('a single code-indented line keeps its footer span — quotation on the one-line path too (#9940 review, audit 5)', () => {
      const code = '    quoted _— x via Qwen Code /review_';
      expect(stripFooterSpans(code)).toBe(code);
      expect(stripFooterSpans('\t_— x via Qwen Code /review_')).toBe(
        '\t_— x via Qwen Code /review_',
      );
      // The marker-stripped shape of a comment whose only content is a
      // quoted footer in a code block: visible code, not "nothing".
      expect(
        stripForUnattributedPost(
          '**[Critical]**\n\n    _— m via Qwen Code /review_',
        ),
      ).toBe('    _— m via Qwen Code /review_');
      expect(
        rendersAsNothing(
          stripForUnattributedPost(
            '**[Critical]**\n\n    _— m via Qwen Code /review_',
          ),
        ),
      ).toBe(false);
    });

    it('a bare-CR body takes the line-aware path — its first line cannot vouch for the rest (#9940 review, round 28)', () => {
      expect(
        stripForUnattributedPost(
          '    quoted code\rmore prose _— gpt-5 via Qwen Code /review (v1.2.3)_ tail',
        ),
      ).toBe('    quoted code\nmore prose tail');
      expect(
        stripForUnattributedPost(
          '    R1-2: the guard drops a case\rmore prose _— qwen3-max via Qwen Code /review (v0.21)_ tail',
        ),
      ).not.toContain('via Qwen Code /review');
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
      expectWithinLatencyBudget(Date.now() - started, 1000, {
        poolMultiplier: 20,
      });
    });
  });
});

describe('FIXED_RULING_SHAPE_RE — the ruling note by its posted shape', () => {
  it('matches every note submit posts and nothing that quotes one (#9940 review, round 30)', () => {
    for (const [body, expected] of RULING_CORPUS) {
      expect([body, FIXED_RULING_SHAPE_RE.test(body)]).toEqual([
        body,
        expected,
      ]);
    }
  });

  it('decides a long run of trailing whitespace in bounded time — the two runs after the marker do not overlap (#9940 review, round 31 reverse audit)', () => {
    // `[ \t]*` followed by `[ \t\r\n]*` gives a run of spaces no unique
    // split, which is quadratic: the same shape in the census dialect made
    // real jq abort with `retry-limit-in-match`, and `set -e` failed the
    // whole scan step. `isRuling` runs this one on every author's body, so
    // the JS spelling owes the same bound.
    for (const pad of [' '.repeat(60000), '\t'.repeat(60000)]) {
      for (const body of [
        `R1-2 fixed by x ${FIXED_RULING_MARKER}${pad}x`,
        `R1-2 fixed by x ${FIXED_RULING_MARKER}\n_— m via Qwen Code /review (v1)_${pad}x`,
      ]) {
        const t0 = Date.now();
        expect(FIXED_RULING_SHAPE_RE.test(body)).toBe(false);
        expectWithinLatencyBudget(Date.now() - t0, 1000, {
          poolMultiplier: 20,
        });
      }
    }
  });

  it('agrees with the autofix census filter, which is a second spelling of the same shape', () => {
    // The workflow cannot import this module, so the shape lives twice —
    // in different regex dialects. Pinned by BEHAVIOUR over the corpus,
    // which is what has to agree; a textual pin would fail on `\d` vs
    // `[0-9]` and say nothing about what either matches.
    // vitest runs with cwd = packages/cli; the workflow is repo-rooted.
    const yaml = readFileSync(
      join(
        import.meta.dirname,
        '../../../../../../.github/workflows/qwen-autofix.yml',
      ),
      'utf8',
    );
    const shape = /^ {2}FIXED_RULING_FILTER: '([^\n]*)'$/m.exec(yaml)?.[1];
    expect(shape).toBeTruthy();
    // One explicit translation, and only one: jq spells a code point
    // `\x{2028}` where JS spells it `\u2028`. Everything else must be
    // character-for-character the same regex.
    const census = new RegExp(
      shape!.replace(/\\x\{([0-9a-fA-F]{4})\}/g, '\\u$1'),
    );
    expect(shape).toContain('[^\\r\\n\\x{2028}\\x{2029}]');
    for (const [body, expected] of RULING_CORPUS) {
      expect([body, census.test(body)]).toEqual([body, expected]);
    }
  });
});
