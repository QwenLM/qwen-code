/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXED_CAPTURE_TIME } from './e2e/visuals/constants';

/*
 * Three contracts the visuals pipeline depends on and that no runtime assertion
 * can reach.
 *
 * They live in a vitest file OUTSIDE `e2e/` on purpose. `vitest.config.ts`
 * excludes `e2e/**`, `playwright.config.ts` ignores `**\/visuals/**`, and the
 * one workflow step that does collect the visuals suite is
 * `continue-on-error: true` by design, so the job stays green and publishes a
 * preview even when a scenario fails. An invariant asserted in there can be
 * violated without any red build. This file is collected by
 * `npm run test:ci:workspaces`, which gates.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VISUALS_DIR = join(HERE, 'e2e/visuals');
const E2E_UTILS_DIR = join(HERE, 'e2e/utils');

function readSources(
  dir: string,
  skip: readonly string[] = [],
): Array<[string, string]> {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !skip.includes(file))
    .map((file) => [
      `${dir.split('/client/')[1]}/${file}`,
      readFileSync(join(dir, file), 'utf8'),
    ]);
}

describe('visual capture contracts', () => {
  it('keeps every hardcoded fixture date before the frozen capture clock', () => {
    // A fixture dated AFTER the frozen instant silently reads as "just now":
    // `formatRelativeTime` measures `Date.now() - value`, a future value yields
    // a negative age, and that lands in the `mins < 1` branch. It already
    // happened -- an earlier constant turned the channel editor's 2026-07-28
    // pairing requests into "just now" and nothing failed; it surfaced only by
    // reading a preview diff by eye.
    //
    // `constants.ts` is skipped because it is where the boundary itself is
    // written. `e2e/utils` is scanned because `mockDaemon.ts` holds the date
    // the default scenario's session rows actually render through
    // `formatRelativeTime` -- scanning only `visuals/` missed it.
    const sources = [
      ...readSources(VISUALS_DIR, ['constants.ts']),
      ...readSources(E2E_UTILS_DIR),
    ];
    const isoLiteral =
      /['"](\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)['"]/g;

    const offenders: string[] = [];
    for (const [name, source] of sources) {
      for (const [, literal] of source.matchAll(isoLiteral)) {
        const at = Date.parse(literal);
        if (Number.isNaN(at)) continue;
        if (at >= FIXED_CAPTURE_TIME.getTime())
          offenders.push(`${name}: ${literal}`);
      }
    }

    // Fix by dating the fixture earlier, not by moving the clock forward: the
    // clock is what every capture renders at, and pushing it out re-dates every
    // other relative label in the suite.
    expect(offenders).toEqual([]);

    // The scan reaches ISO string literals only. Epoch-millis fixtures and
    // date-only strings stay invisible to it, so this is a floor rather than a
    // proof; it fails loudly on the shape that actually regressed.
    expect(sources.length).toBeGreaterThan(5);
  });

  it('keeps both navigation helpers freezing the clock before they navigate', () => {
    // `freezeWallClock` runs only implicitly, and nothing in the visuals suite
    // reads the page clock -- so dropping the call, or moving it after
    // `page.goto`, leaves every test green while timestamped captures silently
    // resume drifting between the base and head passes.
    const harness = readFileSync(join(VISUALS_DIR, 'harness.ts'), 'utf8');

    for (const helper of ['gotoSession', 'gotoNewSession']) {
      const body = harness.slice(
        harness.indexOf(`export async function ${helper}(`),
      );
      const freezeAt = body.indexOf('await freezeWallClock(page);');
      const gotoAt = body.indexOf('await page.goto(');
      expect(freezeAt, `${helper} must call freezeWallClock`).toBeGreaterThan(
        -1,
      );
      expect(gotoAt, `${helper} must navigate`).toBeGreaterThan(-1);
      expect(freezeAt, `${helper} must freeze before navigating`).toBeLessThan(
        gotoAt,
      );
    }
  });

  it('keeps every hover timestamp chip opaque, and `.tip` off the first line', () => {
    // The chips are `opacity: 0` until hover, and after the turn-error captures
    // were dropped no capture paints one -- so reverting an anchor to `top` or
    // restoring a translucent background keeps every suite green while
    // reintroducing the clipped-ascender bug this pins ("finished." rendering
    // as "finisheu.", the shape originally reported through a preview).
    //
    // Opacity is required of every chip: a glyph beneath a translucent overlay
    // composites into it and reads as broken text. The bottom anchor is
    // required only of `.tip`, whose row wraps and therefore has a ragged last
    // line to move into. `.toolTimeTip`'s row cannot wrap and is about as tall
    // as the chip, so it has no slack and stays where it is.
    const chips = [
      ['components/MessageTimestamp.module.css', '.tip', true],
      [
        'components/messages/tools/SubAgentPanel.module.css',
        '.toolTimeRow > .toolTimeTip',
        false,
      ],
    ] as const;

    for (const [file, selector, mustBeBottomAnchored] of chips) {
      const css = readFileSync(join(HERE, file), 'utf8');
      const start = css.indexOf(`${selector} {`);
      expect(start, `${file} must declare ${selector}`).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf('}', start));

      expect(block, `${selector} needs an opaque background`).toMatch(
        /^\s*background:\s*var\(--background\);/m,
      );
      expect(block, `${selector} must not be translucent`).not.toMatch(
        /color-mix/,
      );

      if (mustBeBottomAnchored) {
        expect(
          block,
          `${selector} must not sit on the first line of the row`,
        ).not.toMatch(/^\s*top:/m);
        expect(block, `${selector} must be bottom-anchored`).toMatch(
          /^\s*bottom:/m,
        );
      }
    }
  });
});
