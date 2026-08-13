/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MODELED_SYSTEM_DOMAIN,
  SHELL_MODEL_LAYERS,
  inferLayersFromProse,
  layerCoverage,
  owedLayerDimensions,
  parseLayerReceipts,
  renderShellLayerBriefList,
  uncoveredLayers,
} from './audit-layers.js';

describe('audit-layers taxonomy', () => {
  it('has unique kebab-case ids, non-empty signals, and a brief hint', () => {
    const ids = SHELL_MODEL_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const layer of SHELL_MODEL_LAYERS) {
      expect(layer.id).toMatch(/^[a-z][a-z-]*$/);
      expect(layer.label.length).toBeGreaterThan(0);
      expect(layer.briefHint.length).toBeGreaterThan(0);
      expect(layer.signals.length).toBeGreaterThan(0);
    }
  });

  it('renders the brief layer list from the taxonomy — one source, no drift', () => {
    const rendered = renderShellLayerBriefList();
    for (const layer of SHELL_MODEL_LAYERS) {
      expect(rendered).toContain(`\`${layer.id}\``);
      expect(rendered).toContain(layer.briefHint);
    }
    // What the brief shows and what the parser reads are the same id set.
    expect(
      parseLayerReceipts(`Layer walked: ${SHELL_MODEL_LAYERS[0].id}`).size,
    ).toBe(1);
    // The state layers name the REMOVAL side, not only the add side — an
    // add-only model that never handles `unset -f`/`set +a` is the divergence.
    expect(rendered).toContain('unset -f');
    expect(rendered).toContain('set +a');
  });

  it('names the state layer PR #8687 exposed', () => {
    expect(SHELL_MODEL_LAYERS.map((l) => l.id)).toContain('scope-propagation');
    expect(SHELL_MODEL_LAYERS.map((l) => l.id)).toContain('resolution-order');
    expect(SHELL_MODEL_LAYERS.map((l) => l.id)).toContain('inheritance');
  });
});

describe('parseLayerReceipts', () => {
  it('reads the structured marker and validates the id', () => {
    const text = [
      'Re-walked the evaluator.',
      'Layer walked: scope-propagation — every function-body cwd is merged back.',
      '- Layer walked: resolution-order — checked `git`/`cd` shadowing and `command`.',
      'Layer walked: not-a-real-layer — should be ignored.',
    ].join('\n');
    const ids = parseLayerReceipts(text);
    expect([...ids].sort()).toEqual(['resolution-order', 'scope-propagation']);
  });

  it('returns empty when the marker is absent', () => {
    expect(parseLayerReceipts('No issues found — re-read the diff.').size).toBe(
      0,
    );
  });

  it('does not read the marker when it is QUOTED (fence or blockquote)', () => {
    const fenced = [
      '```',
      'Layer walked: lexing — this is a quotation, not a receipt.',
      '```',
      '> Layer walked: expansion — quoting the format is not using it.',
    ].join('\n');
    expect(parseLayerReceipts(fenced).size).toBe(0);
  });

  it('tolerates markdown emphasis and a full-width colon', () => {
    const text = '**Layer walked:** inheritance — set -a into `$(…)` checked.';
    const zh = 'Layer walked：toctou — 检查了 planted .git 的时序。';
    expect([...parseLayerReceipts(text)]).toEqual(['inheritance']);
    expect([...parseLayerReceipts(zh)]).toEqual(['toctou']);
  });

  it('does not read a marker inside an inline code span or an indented code block', () => {
    // A QUOTED marker is not a USED one. Before this the leading-backtick
    // tolerance and unbounded indent let an auditor enumerating the owed layers
    // in the brief's own backtick-wrapped form mark them covered and release the
    // cap — probe-verified as a real bypass.
    expect(parseLayerReceipts('`Layer walked: toctou — quoted`').size).toBe(0);
    expect(
      parseLayerReceipts('- `Layer walked: scope-propagation — quoted`').size,
    ).toBe(0);
    expect(
      parseLayerReceipts('    Layer walked: inheritance — 4-space code block')
        .size,
    ).toBe(0);
    expect(
      parseLayerReceipts('\tLayer walked: lexing — tab code block').size,
    ).toBe(0);
  });

  it('tracks fences the CommonMark way — a quoted marker survives no divergence', () => {
    // Probe cases from the round-2 review. A naive symmetric toggle released each
    // of these quoted markers as a live receipt (the credit/release direction).
    // (1) a mismatched fence line must not close the block:
    expect(
      parseLayerReceipts(
        ['```', '~~~', 'Layer walked: toctou — quoted', '~~~', '```'].join(
          '\n',
        ),
      ).size,
    ).toBe(0);
    // (2) a list-item fence must open (GitHub renders the marker as quoted code):
    expect(
      parseLayerReceipts(
        ['The form:', '- ```', '  Layer walked: toctou — quoted', '  ```'].join(
          '\n',
        ),
      ).size,
    ).toBe(0);
    // (3) a fence line with trailing content must not close the block:
    expect(
      parseLayerReceipts(
        [
          '```',
          'Layer walked: toctou — quoted',
          '``` end of quote',
          'Layer walked: inheritance — quoted',
          '```',
        ].join('\n'),
      ).size,
    ).toBe(0);
    // A genuine fenced block still closes and a real receipt after it counts.
    expect([
      ...parseLayerReceipts(
        ['```', 'quoted', '```', 'Layer walked: scope-propagation — real'].join(
          '\n',
        ),
      ),
    ]).toEqual(['scope-propagation']);
  });

  it('defers quotation to the authority — constructs a hand-rolled scanner missed', () => {
    // markdown-it owns which lines are quoted, so an HTML block, a tab-indented
    // code line, and a nested blockquote each quote their markers — three of the
    // "four more constructs" a hand-rolled fence toggle released, and the reason
    // this stopped chasing CommonMark corners by hand.
    expect(
      parseLayerReceipts(
        ['<div>', 'Layer walked: toctou — quoted', '</div>'].join('\n'),
      ).size,
    ).toBe(0);
    expect(parseLayerReceipts('\tLayer walked: lexing — quoted').size).toBe(0);
    expect(
      parseLayerReceipts('> > Layer walked: expansion — quoted').size,
    ).toBe(0);
    // A real receipt in plain prose after a quoted block still counts.
    expect([
      ...parseLayerReceipts(
        [
          '<div>',
          'x',
          '</div>',
          '',
          'Layer walked: scope-propagation — real',
        ].join('\n'),
      ),
    ]).toEqual(['scope-propagation']);
    // A receipt after a `>` BLOCKQUOTE counts too — the close-depth decrement
    // must return to 0, or every later inline would be skipped as still-quoted.
    expect([
      ...parseLayerReceipts('> quoted\n\nLayer walked: toctou — real'),
    ]).toEqual(['toctou']);
  });

  it('does not credit a marker hidden in an INLINE construct — the R4-1 residual, closed', () => {
    // Reading the rendered prose (not source lines) drops a marker GitHub shows
    // as nothing or as monospace/attribute text — the inline families a block-only
    // pass leaked. Each verified against markdown-it, GitHub's own family.
    const hidden = [
      '`x\nLayer walked: toctou`', // multi-line inline code span
      '<!-- Layer walked: toctou -->', // HTML comment
      '<a title="Layer walked: toctou">t</a>', // tag attribute value
      '[t](/u "Layer walked: toctou")', // link title
      '[x\nLayer walked: toctou]: /url', // link-reference continuation
      '![Layer walked: toctou](/u)', // image alt — an attribute, never prose
      'Layer walked: `toctou` — styled id', // id inside a code span, dropped
      // A dropped inline node becomes a non-whitespace sentinel, so a marker
      // never stitches across it into an id GitHub renders as one token. Both
      // render two things: "Layer walked: xtoctou" and "Layer walked: ⟨img⟩toctou".
      'Layer walked: `x`toctou', // code span splits marker from id
      'Layer walked: ![a](/u)toctou', // image splits marker from id
      // The sentinel is not a line break either, so an inline node BEFORE a marker
      // leaves it mid-line — exactly where GitHub renders it — not floated to a
      // fresh line start. GitHub shows "x Layer walked: toctou", never a receipt.
      '`x` Layer walked: toctou', // code span before the marker
      // A hard break (two trailing spaces) IS a visible line break, so it splits
      // an inline-`<br>` marker from its id — GitHub shows the id on its own line.
      'Layer walked:  \ntoctou',
      // Raw-text elements (`<script>`, `<style>`, `<textarea>`, `<title>`,
      // `<template>`, `<noscript>`): markdown-it exposes their inner text as a
      // child, but GitHub renders it only inline/escaped, never as a line-leading
      // receipt. The sentinel keeps the marker mid-line, matching that render.
      'x <script>Layer walked: toctou</script>',
      'x <style>Layer walked: toctou</style>',
      'x <textarea>Layer walked: toctou</textarea>',
      'x <title>Layer walked: toctou</title>',
      'x <template>Layer walked: toctou</template>',
      'x <noscript>Layer walked: toctou</noscript>',
      '<script>Layer walked: toctou</script>', // even with no prefix
      // A numeric entity decoding to a newline lands as a raw \n INSIDE a text
      // child (markdown-it decodes at parse time); GitHub collapses that LF to a
      // space, so it must not forge a line start. Mid-line here → not a receipt.
      'x&#10;Layer walked: toctou',
      'x&#x0A;Layer walked: toctou',
      // Two more R4-1 origin families: a terminated multi-line LRD title and an
      // image TITLE attribute — both live in attributes, never in visible prose.
      '[x]: /url "a\nLayer walked: toctou\nb"',
      '![x](/u "Layer walked: toctou")',
      // Trailing stitch — the mirror of the leading cases: a dropped inline node
      // touching the END of the id stitches the visible token into a longer word
      // GitHub renders as one (`toctoux`, `toctou-x`), so it is not a receipt.
      'Layer walked: toctou`x`', // code span after the id
      'Layer walked: toctou<b>x</b>', // inline HTML after the id
      'Layer walked: toctou![a](/u)', // image after the id
      // An INVISIBLE code point (zero-width space, soft hyphen, word joiner)
      // wedged between the id and the text after it renders as one stitched word
      // on GitHub (`toctoux`), so it is not a receipt — the sentinel-only guard
      // would miss these; folding them out of the prose view catches them.
      'Layer walked: toctou&#8203;x', // U+200B zero-width space
      'Layer walked: toctou&#173;x', // U+00AD soft hyphen
      'Layer walked: toctou&#8288;`x`', // U+2060 word joiner + code span
      'Layer walked: toctou&#8294;x', // U+2066 bidi isolate — `\p{Cf}`, not an enum gap
      'Layer walked: toctou&#65039;x', // U+FE0F variation selector
      'Layer walked: toctou&#6157;x', // U+180D Mongolian free variation selector
      // A VISIBLE word constituent stitched onto the id (letter, digit, connector,
      // combining mark) also renders one word GitHub never reads as a receipt —
      // and needs no entity to reach: pure ASCII `toctou_x` leaks without the guard.
      'Layer walked: toctou_x — note', // underscore (connector punctuation)
      'Layer walked: toctoué', // trailing letter
      'Layer walked: toctou&#65400;', // fullwidth `x` (letter)
      'Layer walked: toctou&#1635;', // Arabic-Indic digit three
      'Layer walked: toctou&#769;x', // U+0301 combining acute on the id
      // Punctuation or a symbol stitched between the id and more word content also
      // renders one joined token GitHub never reads as a receipt — pure ASCII, no
      // entity needed. A trailing dash the id class does not swallow (U+2010, not
      // ASCII `-`) is the same shape.
      'Layer walked: toctou.x', // period
      'Layer walked: toctou/x', // slash
      'Layer walked: toctou)x', // close paren
      'Layer walked: toctou$x', // currency symbol
      'Layer walked: toctou&#8208;x', // U+2010 hyphen (a `\p{Pd}` dash)
      'Layer walked: lexing.extra', // id then `.` then more of the word
      'Layer walked: toctou.,x', // chained punctuation then word
      'Layer walked: toctou.<b>x</b>', // punctuation then a dropped node
      // A CONNECTOR (`\p{Pc}`) joins with no word break (UAX#29), so even a lone
      // trailing one renders one word — not a receipt.
      'Layer walked: toctou_', // trailing low line
      'Layer walked: expansion_', // a real layer id, connector-joined
      'Layer walked: toctou&#8255;', // U+203F undertie
      // FORM FEED (U+000C) is JS `\s` but CSS does not collapse it to a space, so
      // GitHub renders it verbatim — a glued phrase or a wedged id, never a receipt.
      'Layer&#12;walked: toctou', // FF glues the phrase
      'Layer walked: toctou&#12;x', // FF wedges the id
      // A bidi control REORDERS the visible text, so the logical marker is not what
      // a human reads — mapped to the opaque sentinel, which breaks the match.
      '&#8238;Layer walked: toctou', // U+202E right-to-left override, line-leading
    ];
    for (const q of hidden) expect(parseLayerReceipts(q).size).toBe(0);
    // Trailing PUNCTUATION with nothing stuck after it is a real boundary — the id
    // still ends its visible word — so these stay credited.
    for (const q of [
      'Layer walked: toctou', // end of line
      'Layer walked: toctou.', // sentence period
      'Layer walked: toctou,', // comma
      'Layer walked: toctou. note', // period then a space
    ]) {
      expect([...parseLayerReceipts(q)]).toEqual(['toctou']);
    }
    // A link's VISIBLE text is prose and still counts, and a hard break BEFORE a
    // whole marker leaves the marker at the start of its own visible line.
    expect([
      ...parseLayerReceipts('[Layer walked: toctou](/u) — real'),
    ]).toEqual(['toctou']);
    expect([...parseLayerReceipts('x  \nLayer walked: toctou')]).toEqual([
      'toctou',
    ]);
    // A `<br>` IS a visible line break on GitHub, so a marker after it starts its
    // own line — a real receipt (the entity LF above collapses; a `<br>` does not).
    // Pin the regex's tolerances (`\/?`, case, attributes) so a regression cannot
    // drop them — GitHub strips a `<br>`'s attributes but keeps the break.
    for (const br of ['<br>', '<br/>', '<BR>', '<br >', '<br class="a">']) {
      expect([...parseLayerReceipts(`x${br}Layer walked: toctou`)]).toEqual([
        'toctou',
      ]);
    }
    // But NOT a `<br-…>` custom element or `<brfoo>` — GitHub strips the
    // non-allowlisted tag, leaving no break, so the marker stays mid-line. The
    // break test must not fabricate a receipt from these (a dropped `\b` would).
    // A NON-ASCII space after `br` is not tag whitespace in the HTML grammar, so
    // GitHub does not parse the tag at all — it must not count as a break either.
    const notBr = [
      '<br-foo>',
      '<brfoo>',
      '<BR-FOO>',
      '<br->',
      '<br\u00A0>', // no-break space — not ASCII tag whitespace
      '<br\u2000>', // en quad
      '<br\u3000>', // ideographic space
    ];
    for (const t of notBr) {
      expect(parseLayerReceipts(`x${t}Layer walked: toctou`).size).toBe(0);
    }
    // A paragraph-LEADING entity newline collapses to a space GitHub renders at
    // paragraph start, so the marker stays a visible receipt.
    expect([...parseLayerReceipts('&#10;Layer walked: toctou')]).toEqual([
      'toctou',
    ]);
    // Carve-out: an invisible wedge sitting just before a REAL break still leaves
    // a clean line-leading receipt — folding it out keeps that credited.
    expect([
      ...parseLayerReceipts('Layer walked: toctou&#8203;  \nmore'),
    ]).toEqual(['toctou']);
  });

  it('folds invisible format characters out of the entity-decoded prose view', () => {
    // markdown-it decodes numeric entities at parse time, so a code point JS `\s`
    // matches but GitHub renders as NOTHING (U+2028/U+2029 line separators, VT,
    // BOM) would glue `layer<x>walked` into a phrase the anchored regex matches
    // yet GitHub shows fused (`layerwalked`). The plain first receipt passes the
    // prefilter (any parroted return carries one); only the glued second must drop.
    for (const cp of ['&#8232;', '&#8233;', '&#11;', '&#65279;']) {
      expect([
        ...parseLayerReceipts(
          `Layer walked: lexing — ok\nlayer${cp}walked: toctou`,
        ),
      ]).toEqual(['lexing']);
    }
    // The fold target for an entity newline must be a SPACE, not empty — else it
    // stitches `Lay`+`er walked` into a line-leading receipt GitHub never renders
    // (it shows `Lay er walked`). A plain marker carries the input past the prefilter.
    expect([
      ...parseLayerReceipts(
        'Layer walked: lexing — real\nLay&#10;er walked: toctou',
      ),
    ]).toEqual(['lexing']);
    // The prefilter reads RAW text; an entity that only DECODES into the marker
    // phrase must not be vetoed before the parser sees the rendered prose. Each of
    // these renders `Layer walked: toctou` on GitHub, so each is a real receipt.
    for (const q of [
      'Layer&#32;walked: toctou', // entity space separator
      '&#76;ayer walked: toctou', // entity-encoded leading `L`
      '&#76;ayer w&#97;lked: toctou', // BOTH words entity-encoded — isolates the entity clause
      'Layer&nbsp;walked: toctou', // named entity → visible nbsp space
      // The two words split by inline markup that the reconstructed prose rejoins:
      // the raw view has no adjacent "layer walked", but the render does — the
      // split can even fall MID-word in BOTH words at once, so the prefilter must
      // strip the markup delimiters before testing, not require either word whole.
      'Layer *walked*: toctou', // emphasis boundary between the words
      'Layer [walked: toctou](/u)', // link boundary between the words
      'La*yer* walked: toctou', // emphasis MID-word in "layer"
      'Layer wal*ked*: toctou', // emphasis MID-word in "walked"
      'La*yer* wal*ked*: toctou', // BOTH words split mid-word
    ]) {
      expect([...parseLayerReceipts(q)]).toEqual(['toctou']);
    }
    // A variation selector (U+FE0F) is folded only by `\p{Variation_Selector}` —
    // not `\p{Cf}` — so this fold-dependent carve-out (VS just before a real break)
    // discriminates that member: dropping it would reject a genuine receipt.
    expect([
      ...parseLayerReceipts('Layer walked: toctou&#65039;  \nmore'),
    ]).toEqual(['toctou']);
    // The combining grapheme joiner (U+034F) — the one enumerated non-`\p{Cf}`
    // member of the fold class — renders as nothing, so a marker wearing it is a
    // real receipt. Pin it: dropping U+034F from the class silently loses this.
    expect([
      ...parseLayerReceipts(
        'Layer walked: lexing — real\nLayer walked&#847;: toctou',
      ),
    ]).toEqual(['lexing', 'toctou']);
  });

  it('credits a marker rendered as VISIBLE prose in any block, not just a paragraph', () => {
    // The source-line scanner this replaced anchored on the raw line and so was
    // blind to a marker GitHub renders as visible prose inside a heading, a table
    // cell, or via an HTML entity. Reading the rendered token stream corrects
    // that: each of these IS a real, visible receipt, so it counts. (Corroboration
    // — identity + territory read — is the separate gate against parroted ones.)
    const visible = [
      '## Layer walked: toctou', // ATX heading text
      '| Layer walked: toctou | x |\n| --- | --- |', // table cell
      'Layer walked: &#x74;octou', // entity id, decoded to `toctou` by the render
    ];
    for (const q of visible)
      expect([...parseLayerReceipts(q)]).toEqual(['toctou']);
    // The interior of a multi-line HTML open tag is raw markup, never prose.
    expect(
      parseLayerReceipts('<a\n    Layer walked: toctou\n    >x</a>').size,
    ).toBe(0);
  });

  it('requires the colon — a colon-less shape is not a receipt', () => {
    // Relaxing the mandatory colon would let colon-less parrot prose parse as a
    // receipt, and that is the credit/release direction.
    expect(
      parseLayerReceipts('Layer walked scope-propagation — no colon').size,
    ).toBe(0);
  });

  it('captures a digit-bearing id without truncating it', () => {
    // Not a shipped shell layer, but the id capture must not silently truncate a
    // digit a programmatic caller's taxonomy might use (`[a-z][a-z0-9-]*`).
    const custom = [
      { id: 'phase2', label: 'x', briefHint: 'x', signals: ['zzz'] },
    ];
    expect([
      ...parseLayerReceipts('Layer walked: phase2 — ok', custom),
    ]).toEqual(['phase2']);
  });
});

describe('layerCoverage', () => {
  it('marks a layer covered by its receipt (finding or clean), and lists the rest as owed', () => {
    const returns = [
      // A receipt whose note records a finding — coverage is the marker, not the
      // finding; a marker-less finding would not count the layer.
      'Layer walked: lexing — a trailing `# comment` swallows the mutating git command.',
      // A dry receipt that names one deep layer, marker on its own line.
      [
        'No issues found — re-walked the evaluator.',
        'Layer walked: scope-propagation — cwd threads back correctly.',
      ].join('\n'),
    ];
    const cov = layerCoverage(returns);
    expect(cov.covered['lexing']).toBe(true);
    expect(cov.covered['scope-propagation']).toBe(true);
    // The layers nobody walked are exactly what a "two dry rounds" stop would hide.
    expect(cov.uncovered).toEqual([
      'expansion',
      'resolution-order',
      'inheritance',
      'toctou',
    ]);
  });

  it('a token-only run leaves the state layers uncovered — the #8687 shape', () => {
    const tokenOnly = [
      'Layer walked: lexing — glob and `-oc` bundle both denied.',
      'Layer walked: lexing — backtick substitution denied.',
    ];
    expect(uncoveredLayers(tokenOnly)).toContain('scope-propagation');
    expect(uncoveredLayers(tokenOnly)).toContain('resolution-order');
  });

  it('a fully-receipted run owes nothing', () => {
    const full = SHELL_MODEL_LAYERS.map(
      (l) => `Layer walked: ${l.id} — examined, clear.`,
    );
    expect(layerCoverage(full).uncovered).toEqual([]);
  });

  it('keyword fallback estimates coverage on marker-less (baseline) transcripts', () => {
    // A pre-brief auditor return with no marker but prose that names the concept.
    const baseline = [
      'The guard fails open on a trailing comment token and a glob.',
      'A command substitution `$(…)` inherits set -a but does not propagate back.',
    ];
    // Structured-only: nothing is receipted, so everything reads as owed.
    expect(layerCoverage(baseline).uncovered.length).toBe(
      SHELL_MODEL_LAYERS.length,
    );
    // With the fallback on, the prose is credited approximately.
    const est = layerCoverage(baseline, { keywordFallback: true });
    expect(est.covered['lexing']).toBe(true);
    expect(est.covered['expansion']).toBe(true);
    expect(est.covered['inheritance']).toBe(true);
  });
});

describe('inferLayersFromProse', () => {
  it('is signal-specific, not a catch-all', () => {
    // A generic all-clear names no layer concept, so it infers nothing.
    expect(
      inferLayersFromProse('No issues found — re-read the whole diff.').size,
    ).toBe(0);
    // Generic review vocabulary must not infer a layer either, or the keyword
    // estimate would credit coverage to any prose that mentions the diff.
    expect(
      inferLayersFromProse(
        'Reviewed the changed files and the diff thoroughly.',
      ).size,
    ).toBe(0);
  });

  it('does not infer a layer from a signal that lives in quoted text', () => {
    // The `--infer` estimate skips fenced code and blockquotes exactly as the
    // structured parser does — a signal quoted, not used, credits nothing.
    const quoted = [
      '```',
      'a command substitution $(…) inherits set -a',
      '```',
      '> export -f is imported by a child shell',
    ].join('\n');
    expect(inferLayersFromProse(quoted).size).toBe(0);
  });

  it('shares the receipt parser quotation view — an inline-code signal is dropped', () => {
    // Moving to the token authority made an inline code span quoted for this
    // estimate too. The only difference between these two is the backticks, so a
    // signal named in a code span infers nothing where the bare token infers a
    // layer. That can UNDER-count a layer the auditor did name — but that only
    // owes MORE (fail-safe), acceptable for a non-authoritative guess.
    expect(
      inferLayersFromProse('the guard mishandles set -a expansion').size,
    ).toBeGreaterThan(0);
    expect(
      inferLayersFromProse('the guard mishandles `set -a` expansion').size,
    ).toBe(0);
  });
});

describe('owedLayerDimensions', () => {
  it('turns each unwalked layer into a self-explained cap entry', () => {
    const owed = owedLayerDimensions([
      'Layer walked: lexing — glob denied.',
      'Layer walked: expansion — $(…) denied.',
    ]);
    // The four unwalked layers, each a reverse-audit cap line.
    expect(owed).toHaveLength(4);
    expect(owed.some((e) => e.includes('scope-propagation'))).toBe(true);
    for (const e of owed)
      expect(e).toMatch(
        /^reverse-audit layer coverage — the .+ was never walked$/,
      );
    // The prefix is deliberately NOT the bare `reverse audit — ` an orchestrator
    // writes for a whiffed scope: that one would be shadowed by compose-review's
    // `reverse audit` coverage subject in the caller-echo dedup.
    for (const e of owed) expect(e.startsWith('reverse audit — ')).toBe(false);
  });

  it('owes nothing when every layer was walked', () => {
    const full = SHELL_MODEL_LAYERS.map(
      (l) => `Layer walked: ${l.id} — clear.`,
    );
    expect(owedLayerDimensions(full)).toEqual([]);
  });

  it('exports the manifest domain sentinel the gate keys on', () => {
    expect(MODELED_SYSTEM_DOMAIN).toBe('modeled-executable-system');
  });
});
