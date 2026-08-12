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
    expect(cov.coveredBy['lexing']).toEqual([0]);
    expect(cov.coveredBy['scope-propagation']).toEqual([1]);
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
