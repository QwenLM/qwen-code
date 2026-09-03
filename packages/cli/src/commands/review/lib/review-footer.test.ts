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
  stripReviewFooterLine,
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

    it('a model part ending in `_—` still strips — the marker literal owns its only space', () => {
      // The `(?!_— )` middle guard blocked the middle at the inner `_— `, and
      // the leftover suffix could not match either: an empty middle needs the
      // `_— ` + ` via` spacing and the opener already consumed the shared
      // space. The pre-guard regex matched all of these, and the
      // attribution-on legs run ONLY this trailing strip — so the forgery
      // posted above the canonical footer. The shape is the loop-model
      // truncation class this file targets: a cut-and-restart landing
      // directly before ` via`.
      for (const forged of [
        'prose\n\n_— _— via Qwen Code /review_',
        'prose\n\n_— _— via Qwen Code /review (v1.2.3)_',
        'prose\n\n_— x_— via Qwen Code /review_',
        'prose\n\n_— x_— via Qwen Code /review (v1.2.3)_',
      ]) {
        expect(stripReviewFooter(forged)).toBe('prose');
      }
      // The guard's own purpose stands: the two-space `_—  via` shape IS a
      // self-sufficient empty-middle footer, and a run of footers joined on
      // ONE line still parses exactly one way. (The folded-title prose the
      // guard exists to keep is pinned by `stripReviewFooterLine` below.)
      expect(stripReviewFooter('prose\n\n_—  via Qwen Code /review_')).toBe(
        'prose',
      );
      expect(
        stripReviewFooter(
          'prose\n\n_— a via Qwen Code /review_ _— b via Qwen Code /review_',
        ),
      ).toBe('prose');
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

    it('an indented footer line a paragraph or list item lazily continues is prose, not a quotation', () => {
      // An indented code block cannot interrupt a paragraph, so GitHub
      // renders these lines visibly: a 4-space line directly after a
      // paragraph line is a lazy continuation, and inside the list items
      // the content indent (2 for `- `, 3 for `1. `) leaves a 4-space
      // line as item prose, not the item's code. The scan used to read
      // all of them as code and blank them, keeping the forged footer.
      expect(
        stripReviewFooter('a finding\n    _— m via Qwen Code /review_'),
      ).toBe('a finding');
      expect(stripReviewFooter('- item\n    _— m via Qwen Code /review_')).toBe(
        '- item',
      );
      expect(
        stripReviewFooter('1. finding\n\n    _— m via Qwen Code /review (v1)_'),
      ).toBe('1. finding');
    });

    it('measures a leading tab at the 4-column stop — a tab-indented line is code', () => {
      // A leading tab lands on the 4-column stop on GitHub, so the line
      // IS code: a footer quoted in it stays, and an unterminated `<!--`
      // quoted in it blanks instead of blinding the strip — the exact
      // bug class this strip exists for, alive through tab-indented code.
      const quoted = 'a finding\n\n\t_— m via Qwen Code /review_';
      expect(stripReviewFooter(quoted)).toBe(quoted);
      expect(
        stripReviewFooter('a finding\n\n\t<!--\n\n_— m via Qwen Code /review_'),
      ).toBe('a finding\n\n\t<!--');
    });

    it('an unterminated opener in a fence info string does not blind the strip', () => {
      // GitHub renders neither the fence delimiters nor an opener's info
      // string, so the edges blank with the content: a `<!--` lodged in
      // the info string used to stay in the projection, run to the end
      // of the input, and hide the trailing footer the strip removes.
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

    it('a comment closer quoted in code still closes the projected comment', () => {
      // The dual of the hole this strip fixes: the scan models the
      // comment's HTML block, so a fence delimiter inside it never opens
      // fence state and the `-->` that ends the block on GitHub survives
      // the blanking. Unmodeled, the closer line blanked, the opener ran
      // to the end of the input, and the real trailing footer survived —
      // the indented twin likewise.
      expect(
        stripReviewFooter('<!--\n```\n-->\n\n_— m via Qwen Code /review_'),
      ).toBe('<!--\n```\n-->');
      expect(
        stripReviewFooter('<!--\n    -->\n\n_— m via Qwen Code /review_'),
      ).toBe('<!--\n    -->');
    });

    it('raw-HTML blocks of types 2-5 hold their lines — a fence inside never toggles', () => {
      // CommonMark comment/PI/declaration/CDATA blocks run to their
      // terminating string; a fence delimiter inside is part of the raw
      // block, and GitHub renders the footer after it as visible prose.
      // The scan used to let the delimiter open fence state that
      // outlived the block, blanking the prose and keeping the footer.
      expect(
        stripReviewFooter('<!--\n```x -->\n_— m via Qwen Code /review_'),
      ).toBe('<!--\n```x -->');
      expect(
        stripReviewFooter('<?\n```x ?>\n_— m via Qwen Code /review_'),
      ).toBe('<?\n```x ?>');
      expect(
        stripReviewFooter('<![CDATA[\n```x ]]>\n_— m via Qwen Code /review_'),
      ).toBe('<![CDATA[\n```x ]]>');
      // The comment renders nothing, so the cut may span it — the
      // parent commit stripped this shape to the prose alone, and the
      // forged footer must not survive beside the canonical one.
      expect(
        stripReviewFooter(
          '[Suggestion] tidy\n<!--\n```x -->\n_— forged via Qwen Code /review_',
        ),
      ).toBe('[Suggestion] tidy');
    });

    it('blanks from the body start, not the tail — a fence straddling the tail bound keeps its state', () => {
      // The blanking scans from the body's START: a fence opened before
      // the STRIP_TAIL_LIMIT tail window keeps its state across the
      // boundary. A tail-only scan would read the quoted code as
      // ordinary text and the unblanked shape would swallow the trailing
      // footer — the fixture must exceed the bound with the fence
      // opening ahead of it and the comment's opener inside it.
      const fillerA = 'a'.repeat(4000);
      const fillerB = 'b'.repeat(4500);
      const quoted =
        'W:\n```\n' + fillerA + '\n<!--\n' + fillerB + '\n-->\n```';
      const body = quoted + '\n\n_— m via Qwen Code /review_';
      expect(body.length).toBeGreaterThan(8192);
      expect(stripReviewFooter(body)).toBe(quoted);
    });

    it('keeps CRLF and bare-CR endings byte-identical when it strips', () => {
      // The reconstruction reattaches each line's own ending and the cut
      // slices the ORIGINAL bytes — unlike the sibling strips, which
      // normalize CRLF to LF on the rejoin. Both a fenced and an
      // indented quotation must survive the blanking's length arithmetic
      // under CRLF and bare CR alike.
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

    it('a one-line body dense with unclosed openers stays linear — no per-opener end scan', () => {
      // The unclosable branch classified each opener with an
      // end-of-input `indexOf('-->')` plus an `indexOf('\u0000')`
      // remainder scan — O(k·n) in the opener count (probe-measured ~4×
      // per doubling at 14 k / 28 k / 56 k chars), where the merge base
      // was flat. Precomputed next positions decide each opener in O(1);
      // the output assertion alone has no teeth (the unclosable openers
      // stay literal either way), so bound the wall time.
      const opener = 'x <!-- y ';
      const body = `${opener.repeat(30_000)}_— m via Qwen Code /review_`;
      const start = performance.now();
      expect(stripFooterSpans(body)).toBe(opener.repeat(30_000).trimEnd());
      expect(performance.now() - start).toBeLessThan(2000);
    }, 30_000);

    it('the whole-body parse stays linear on that body — the inline pass is off', () => {
      // `blankQuotedCode` and `scanLines` read only `token.type` and
      // `token.map`, which the `block` core rule produces. Keeping
      // markdown-it's inline pass made the parse quadratic on exactly the
      // body above (~4x per doubling, measured 11.7 s at 115 KB), and these
      // bodies reach `stripReviewFooter` raw and unbounded from submit's
      // posting path. The linearity test above cannot see it: `stripFooterSpans`
      // takes the no-newline fast path and never parses.
      const opener = 'x <!-- y ';
      const body = `${opener.repeat(30_000)}_— m via Qwen Code /review_`;
      const start = performance.now();
      expect(stripReviewFooter(body)).toBe(opener.repeat(30_000).trimEnd());
      expect(performance.now() - start).toBeLessThan(2000);
      // The attribution-off chain parses once per fixpoint iteration.
      const offStart = performance.now();
      stripForUnattributedPost(body);
      expect(performance.now() - offStart).toBeLessThan(4000);
    }, 60_000);

    it('classifies code versus prose with a CommonMark parser, not a hand model', () => {
      // The hand-built block scan disagreed with the renderers on lazy
      // continuation, list content indents, fence-closer bounds, quote
      // prefixes, and paragraph interruption — each divergence kept a
      // forged trailing footer. The blanking now delegates to a
      // CommonMark parser's token map; these shapes render the footer
      // as visible prose and must strip.
      expect(
        stripReviewFooter('> finding\n    _— m via Qwen Code /review_'),
      ).toBe('> finding');
      expect(
        stripReviewFooter('-   item\n\n      _— m via Qwen Code /review_'),
      ).toBe('-   item');
      expect(
        stripReviewFooter('1.  item\n\n       _— m via Qwen Code /review_'),
      ).toBe('1.  item');
      expect(
        stripReviewFooter(
          '- x\n ```\n code\n ```\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('- x\n ```\n code\n ```');
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
      // A >= 4-column `<div>` line is indented code, not an HTML block.
      expect(
        stripReviewFooter(
          'x\n\n    <div>\n    <!-- y\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('x\n\n    <div>\n    <!-- y');
      // Type-1 raw-HTML content renders literally and is never blanked,
      // so the unclosed opener it quotes classifies literal and the
      // footer after the block strips.
      expect(
        stripReviewFooter('<pre>\n<!--\n</pre>\n\n_— m via Qwen Code /review_'),
      ).toBe('<pre>\n<!--\n</pre>');
    });

    it('classifies the anywhere strips through the CommonMark parser too', () => {
      // The line-aware strips read the parser's token map exactly like
      // the blanking: lists interrupt paragraphs (a 4-space footer line
      // inside the item is a visible paragraph, not a quotation), a
      // fence inside an open item measures its indent against the item's
      // content indent (the quoted footer stays), a setext underline
      // ends the paragraph (the 4-space line after it is a code block
      // the strip keeps), and the item's content indent is the ACTUAL
      // whitespace after the marker, not marker + 1.
      expect(
        stripForUnattributedPost(
          'para\n- item\n\n    _— m via Qwen Code /review_\n\nmore',
        ),
      ).toBe('para\n- item\n\nmore');
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

    it('pins the keep side of the classifier — breaks, headings, and the list code threshold', () => {
      // A heading or thematic break interrupts a paragraph, so a
      // 4-space footer line after one is an indented code block the
      // strip keeps, and inside a list item the code threshold rises
      // by the item's content indent. Unpinned, a dropped check would
      // silently delete footer lines GitHub renders as code.
      const keep = (body: string): void => {
        expect(stripReviewFooter(body)).toBe(body);
      };
      keep('a finding\n---\n    _— m via Qwen Code /review_');
      keep('# h\n    _— m via Qwen Code /review_');
      keep('a finding\n## h\n    _— m via Qwen Code /review_');
      keep('- item\n\n        _— m via Qwen Code /review_');
      keep('- item\n# h\n\n    _— m via Qwen Code /review (v1)_');
    });

    it('a prose comment no longer closes on a closer quoted in code', () => {
      // The blanking NULs the fence's lines, so the closer quoted
      // inside it is gone from the projection; an unclosed opener
      // renders as escaped literal prose (`&lt;!--`), not a comment
      // running to the end of the input — swallowing the tail there
      // kept the forged footer beside the canonical one. The
      // block-level-opener control stays pinned by the comment-closer
      // test above.
      expect(
        stripReviewFooter(
          'See <!--\n```\n-->\n```\nfinding\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('See <!--\n```\n-->\n```\nfinding');
      // A prose opener whose closer sits PAST a code block is
      // unclosable for the same reason — the fence ends the opener's
      // paragraph.
      expect(
        stripReviewFooter(
          'a <!--\n```\nx\n```\nb -->\n\n_— m via Qwen Code /review_',
        ),
      ).toBe('a <!--\n```\nx\n```\nb -->');
    });

    it('a dangling opener after the trailing footer does not break the anchor', () => {
      // A looping model truncates a forged footer mid-character and a
      // dangling `<!--` can ride the footer's own line or a later one.
      // The opener's line carries nothing visible past it, so it must
      // not defeat the `$` anchor the way a literal-projection tail
      // did — the forged footer posts above the canonical one at
      // submit's splice otherwise. An opener with VISIBLE content
      // after it on the line stays literal (the footer before it still
      // strips; the pin above keeps the content-before case intact).
      expect(stripReviewFooter('x\n\n_— m via Qwen Code /review_ <!--')).toBe(
        'x',
      );
      expect(stripReviewFooter('x\n\n_— m via Qwen Code /review_\n<!--')).toBe(
        'x',
      );
      // The attribution-off anywhere strip reads the same projection.
      expect(stripForgedFooterLines('_— m via Qwen Code /review_ <!--')).toBe(
        '',
      );
    });

    it('a line-leading unclosed opener opens a raw block that renders nothing — the footer BEFORE it strips', () => {
      // A line-leading unclosed `<!--` — up to 3 leading spaces, at any
      // blockquote depth — opens a CommonMark type-2 html_block GitHub
      // renders as nothing to end of input, unlike a mid-line opener,
      // which renders as escaped literal prose. Keeping the line-leading
      // one literal defeated the `$` anchor and kept the forged footer
      // BEFORE it (the merge base swallowed the tail and stripped this
      // shape). The trigger is a looping model's truncated copy of the
      // invisible marker this codebase appends.
      expect(
        stripReviewFooter(
          'x\n\n_— m via Qwen Code /review_\n<!-- qwen-review suggestion',
        ),
      ).toBe('x');
      expect(
        stripReviewFooter('x\n\n_— m via Qwen Code /review_\n   <!-- y'),
      ).toBe('x');
      expect(
        stripReviewFooter('x\n\n_— m via Qwen Code /review_\n> <!-- y'),
      ).toBe('x');
      // A 4-space indent is code, not an opener — the blanking keeps the
      // quotation and the trailing footer after it still strips.
      expect(
        stripReviewFooter('x\n\n    <!-- y\n\n_— m via Qwen Code /review_'),
      ).toBe('x\n\n    <!-- y');
    });

    it('strips through sanitizer-dropped raw HTML trailing the footer — types 3-5', () => {
      // `<?…?>` PIs, `<!LETTER…` declarations, and `<![CDATA[…]]>`
      // render nothing on GitHub exactly like comments — trailing the
      // footer they defeat the `$` anchor while GitHub displays the
      // footer alone. Closed spans drop like closed comments; a
      // line-leading unclosed opener opens the block form, rendering
      // nothing to end of input.
      for (const tail of [
        '<?xml version="1.0"?>',
        '<? note',
        '<!DOCTYPE html>',
        '<![CDATA[x]]>',
      ]) {
        expect(stripReviewFooter(`_— m via Qwen Code /review_\n${tail}`)).toBe(
          '',
        );
      }
      // The one-line channel carries the same closure.
      expect(
        stripReviewFooterLine(
          '_— m via Qwen Code /review_ <?xml version="1.0"?>',
        ),
      ).toBe('');
    });

    it('a declaration whose terminator sits on a later line cannot throw out of the strip', () => {
      // The line-leading swallow retracted by INPUT-character count, but the
      // type-4 declaration arm consumes characters inside that window
      // without pushing any of them — its terminator is the first bare `>`,
      // which can sit on a later line. `starts.length -= count` then
      // assigned a negative array length and threw an uncaught RangeError
      // out of the strip, which submit runs on every drafted comment body
      // outside any handler: the command failed and the review never
      // posted. Retracting by original index cannot underflow.
      for (const body of [
        '<!DOCTYPE html\n> <?php echo $user->name',
        '<!A\n><?',
        '<!A\n> <?',
        '<!DOCTYPE html\n\n> <? some code',
        '<!DOCTYPE html\n> <!-- unclosed comment quoted here',
      ]) {
        expect(() => stripReviewFooter(body)).not.toThrow();
      }
      // Not only "does not throw": clamping the count silences the
      // RangeError and still truncates the projection, so the footer ahead
      // of the declaration must actually strip.
      expect(
        stripReviewFooter('X _— m via Qwen Code /review\n<!A\n > <?'),
      ).toBe('X');
    });

    it('a NUL quoted in the body is not the blanking sentinel', () => {
      // `blankQuotedCode` writes NULs onto code lines and the projection
      // reads a NUL as "blanked code a closer cannot cross". A body quoting
      // one between a type 2-5 opener and its real closer therefore demoted
      // a closable construct to unclosable, and the line-leading swallow
      // hid the trailing forged footer from every strip.
      expect(
        stripReviewFooter('<!-- a\u0000b -->\n\n_— m via Qwen Code /review_'),
      ).toBe('<!-- a\u0000b -->');
      expect(
        stripReviewFooter('<? a\u0000b ?>\n\n_— m via Qwen Code /review_'),
      ).toBe('<? a\u0000b ?>');
    });

    it('the anywhere strips normalize a source NUL too — the projection reads one as the sentinel', () => {
      // `normalizeSourceNuls` ran at only two of the projection's entry
      // points: a NUL inside a CLOSED comment demoted it to unclosable for
      // `stripForgedFooterLines` and `stripFooterSpans`, shielding a forged
      // footer line the trailing strip removed — a mode-dependent
      // contradiction between two strips of this file, on the binary-adjacent
      // paste `normalizeSourceNuls`' own doc names. Normalization is
      // length-preserving, so the cut still returns the original bytes.
      expect(
        stripForgedFooterLines(
          'x\n\n_— m via Qwen<!-- \u0000 --> Code /review_',
        ),
      ).toBe('x');
      expect(
        stripForUnattributedPost(
          'prose\n<!-- \u0000 --> _— m via Qwen Code /review_\nmore',
        ),
      ).toBe('prose\nmore');
      expect(
        stripFooterSpans('x _— m via Qwen<!-- \u0000 --> Code /review_ tail'),
      ).toBe('x tail');
    });

    it('the marker gate opens on a raw construct the projection drops', () => {
      // Dropping `<?…?>` spans lets the marker assemble across a dropped
      // span — `Qwen<?x?> Code /review` — with no literal marker, `&`,
      // or `<!--` in the raw line; without a `<` arm the gate never
      // admits it and the hole reopens.
      expect(stripReviewFooterLine('x _— m via Qwen<?x?> Code /review_')).toBe(
        'x',
      );
    });
  });

  describe("stripReviewFooterLine — the one-line channels' shape", () => {
    it('strips a trailing footer a folded line carries — a single line is no block quotation', () => {
      // The one-line channels (folded deferral titles, reroute records,
      // relocated claims) flatten every code shape before they post, so
      // the blanking the multi-line strip applies cannot keep a footer
      // here: a fence delimiter leading the line is posted text, and the
      // forged attribution must not ride it.
      expect(
        stripReviewFooterLine('tidy ``` _— m via Qwen Code /review_'),
      ).toBe('tidy ```');
      expect(stripReviewFooterLine('``` _— m via Qwen Code /review_')).toBe(
        '```',
      );
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

    it('an unterminated comment ahead of the footer does not blind the strip', () => {
      // The unclosed opener renders as escaped literal prose on GitHub,
      // so the strip sees the footer through it and the cut consumes
      // the opener's delimiter with the whitespace before the footer.
      expect(stripReviewFooterLine('x <!-- _— m via Qwen Code /review_')).toBe(
        'x',
      );
    });

    it('the cut neutralizes an unclosed opener left ahead of the footer', () => {
      // The cut slices the ORIGINAL line, so an opener with visible prose
      // between it and the footer came back with its delimiter intact —
      // line-leading, that opens a CommonMark type-2 html_block swallowing the
      // rest of the posted line, which the delimiter's own contract
      // (neutralized same-length first, or the opener's bytes survive the cut)
      // promises cannot happen.
      expect(
        stripReviewFooterLine('x <!-- note _— m via Qwen Code /review_'),
      ).toBe('x      note');
      expect(
        stripReviewFooterLine('<!-- note _— m via Qwen Code /review_'),
      ).toBe('     note');
      // A line with no footer to strip still returns byte-identical: the
      // residue pass is part of the cut, not a rewrite of every line.
      expect(stripReviewFooterLine('x <!-- note')).toBe('x <!-- note');
    });

    it('a closed comment cannot split, trail, or shield the forged footer', () => {
      // The strip matches the comment-DROPPING display projection: a
      // closed span inside the marker phrase displays rejoined, a
      // closed pair before the footer displays nothing between, and a
      // non-empty comment after a complete footer displays nothing
      // past it — none of them may break the match or survive the cut.
      expect(
        stripReviewFooterLine('x _— m via Qwen<!-- --> Code /review_'),
      ).toBe('x');
      expect(
        stripReviewFooterLine('x <!-- hidden --> _— m via Qwen Code /review_'),
      ).toBe('x');
      expect(
        stripReviewFooterLine('_— m via Qwen Code /review_ <!-- r3 -->'),
      ).toBe('');
    });

    it('the middle cannot cross an earlier span opener — a folded title keeps its prose', () => {
      // The one-line channels strip a FOLDED title. Without FOOTER_SPAN_RE's
      // `_— ` guard the middle joined an early opener with the entry's
      // trailing marker phrase and silently deleted every word between — a
      // join the multi-line shape cannot make, because `[^\n]` blocks the
      // line break the fold removed.
      expect(
        stripReviewFooterLine(
          'tidy the helper _— x Failure scenario: the record _— m via Qwen Code /review_',
        ),
      ).toBe('tidy the helper _— x Failure scenario: the record');
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

    it('keeps the line an html_block type 1-5 ends on — dropping it uncloses the block', () => {
      // The terminator line is a quotation edge like the opener: a forged
      // footer riding `-->`, `?>` or `</pre>` used to drop, which unclosed
      // the block and re-rendered everything after it — GitHub then
      // swallowed the reviewer's own content. The footer survives instead
      // (fails open).
      for (const body of [
        '<!--\n_— x --> y via Qwen Code /review_\nreal content',
        '<?\n_— x ?> y via Qwen Code /review_\nreal content',
        '<pre>\n_— x </pre> y via Qwen Code /review_\nreal content',
      ]) {
        expect(stripForgedFooterLines(body)).toBe(body);
      }
      expect(
        stripCommentMarkerLines(
          '<!--\n<!-- qwen-review critical -->\nreal content',
        ),
      ).toBe('<!--\n<!-- qwen-review critical -->\nreal content');
      // A block that opens AND closes on one line still drops: removing that
      // line removes the whole block, so nothing is left unclosed — and
      // keeping it would defeat the bare marker line this strip exists for.
      expect(
        stripCommentMarkerLines('a finding\n\n<!-- qwen-review critical -->'),
      ).toBe('a finding');
    });

    it('a DANGLING html_block has no terminator line to protect — its last line drops', () => {
      // `endEdge` exists because dropping a TERMINATOR uncloses the block and
      // re-renders everything after it. A block that never met its terminator
      // ran to end of input: its last line carries no terminator, dropping it
      // uncloses nothing, and protecting it anyway kept a forged footer riding
      // one through the whole attribution-off chain — the residue these strips
      // exist to remove. The pin above keeps a TERMINATED block's last line
      // protected, and reds if `endEdge` is deleted rather than conditioned.
      for (const [body, kept] of [
        ['<!-- q\n_— forged via Qwen Code /review_', '<!-- q'],
        ['<? q\n_— forged via Qwen Code /review_', '<? q'],
        ['<!DOCTYPE q\n_— forged via Qwen Code /review_', '<!DOCTYPE q'],
        ['<![CDATA[ q\n_— forged via Qwen Code /review_', '<![CDATA[ q'],
        ['<pre>\n_— forged via Qwen Code /review_', '<pre>'],
      ] as const) {
        expect(stripForgedFooterLines(body)).toBe(kept);
      }
      expect(
        stripForUnattributedPost(
          '> <!-- q\n> _— forged via Qwen Code /review_',
        ),
      ).toBe('> <!-- q');
    });

    it('endEdge fails open on a DROP only — an in-place map still reaches the terminator line', () => {
      // Dropping a terminator uncloses its block; rewriting it never did.
      // Skipping EVERY map on the line let a forged footer glued AFTER a type
      // 1-5 terminator — visible text past the closing tag on GitHub — survive
      // the attribution-off chain, and let a planted severity marker ride one
      // past `stripParagraphMarkers`.
      expect(
        stripForUnattributedPost(
          '<pre>\nx\n</pre> _— m via Qwen Code /review_\n\nreal trailing prose',
        ),
      ).toBe('<pre>\nx\n</pre> \n\nreal trailing prose');
      expect(
        stripForUnattributedPost(
          '[Critical] finding\n<!--\n--> _— forged via Qwen Code /review_\nmore',
        ),
      ).toBe('[Critical] finding\n<!--\n--> \nmore');
      expect(
        stripParagraphMarkers('<pre>\nx\n**[Critical]** </pre> real'),
      ).toBe('<pre>\nx\n</pre> real');
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
        // The module models a type-5 CDATA block as rendering nothing — the
        // sanitizer drops it — but the declaration replace cannot match
        // `<![CDATA[` (`[` is not a letter), so a CDATA-only entry passed the
        // gate that exists to refuse invisible entries.
        '<![CDATA[x]]>',
        '<![CDATA[x',
        '<script>alert(1)</script>',
        '[label]: /url',
      ]) {
        expect(rendersAsNothing(scaffold)).toBe(true);
      }
    });

    it('strips by earliest opener — a construct quoted inside another cannot eat past its end', () => {
      // Sequential strips ran the comment and `<?` arms BEFORE the CDATA one,
      // so either sitting inside a CDATA payload ate past the `]]>` to end of
      // input and took the visible text after the section with it; the CDATA
      // arm then ate the orphaned opener and the function certified visible
      // content as rendering nothing — submit's pre-post gate refuses a valid
      // drafted comment on that false diagnosis. These constructs never nest,
      // so the first opener claims its closer.
      expect(rendersAsNothing('<![CDATA[ <? ]]> visible')).toBe(false);
      expect(rendersAsNothing('<![CDATA[ <!-- ]]> visible')).toBe(false);
      expect(rendersAsNothing('<![CDATA[ <script> ]]> visible')).toBe(false);
      // Earliest-opener ORDER, not merely "CDATA first": the naive reorder of
      // the old sequential strips reds here.
      expect(rendersAsNothing('<!-- <![CDATA[ --> visible')).toBe(false);
      // Each arm keeps its unclosed-opener-runs-to-end-of-input semantics.
      expect(rendersAsNothing('<![CDATA[x')).toBe(true);
      expect(rendersAsNothing('<![CDATA[ <? ]]>')).toBe(true);
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
      // Comment/PI/declaration/CDATA blocks swallow the appended marker
      // to NOTHING — the exposure this gate refuses is a marker that
      // renders VISIBLE. A dangling (or closed) type 2-5 block posts
      // fine; only the tag-based blocks (the <pre> control above) count.
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
