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
 * Contracts the visuals pipeline depends on and that no runtime assertion
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

  it('keeps the visuals suite rendering with prefers-reduced-motion: reduce', () => {
    // `captureScreenshot` passes `animations: 'disabled'`, which only settles
    // animations that are ALREADY running when the screenshot starts. The
    // artifact dock's open animation is not one it can be relied on for:
    // `artifactPanelDockOpen` drives `flex-basis`/`width` from 0 to
    // `--artifact-panel-dock-width` over 200ms, so the docked panel's divider
    // sweeps the full panel width, and no assertion in any screenshot spec
    // gates on the dock. Measured on the cockpit scenario (#11465): at the
    // mutation that inserts `.artifactPanelDock`, `dock.getAnimations()`
    // reports `artifactPanelDockOpen` as `running` at `currentTime: 0` with the
    // dock's rect at `width: 0` and the divider at `x: 1276`; once settled it
    // is `width: 504` at `x: 772`. Whether a capture lands inside that window
    // is then a timing race between the dock mounting and the spec's
    // pre-capture waits -- the shape #11465 reports for this view: a
    // full-height divider a few px off, 1.31% on one render of a tree and 0%
    // on a re-run of the same commit.
    //
    // The CSS already ships an opt-out for exactly this, but Playwright's
    // default is `no-preference` (measured in the same runs:
    // `matchMedia('(prefers-reduced-motion: reduce)').matches === false`), so
    // it never applied. Both halves are asserted because either one alone is
    // inert: dropping the config setting re-arms the race, and dropping the CSS
    // block makes the config setting a no-op while every test stays green.
    //
    // The config half has to be asserted in its `contextOptions` form, not just
    // as a bare `reducedMotion: 'reduce'`. The runner only forwards the options
    // it declares itself (`viewport`, `userAgent`, `colorScheme`, ...);
    // `reducedMotion` is not one of them, so hoisting it out of
    // `contextOptions` reads back correctly from `project.use` and still leaves
    // the page on `no-preference`. That refactor looks like a cleanup, keeps
    // this suite green on the string alone, and silently re-arms the race.
    const config = readFileSync(
      join(HERE, '..', 'playwright.visuals.config.ts'),
      'utf8',
    );
    expect(
      config,
      'visuals config must force reduced motion through contextOptions',
    ).toMatch(/contextOptions:\s*\{[^}]*reducedMotion:\s*'reduce'/);

    const appCss = readFileSync(join(HERE, 'App.module.css'), 'utf8');
    expect(
      appCss,
      'the reduced-motion media block must still opt the dock out of its open animation',
    ).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\.artifactPanelDock\s*\{[^}]*animation:\s*none/,
    );
  });

  it('keeps the cockpit capture dropping the autofocus ring before the shutter', () => {
    // Which element holds focus is capture-relevant state, and nothing else in
    // the pipeline pins it. The cockpit autofocuses its back button on mount
    // (`SessionWorkflowCockpit.tsx`: `backButtonRef.current?.focus()`), and
    // whether Chrome paints the `:focus-visible` ring for a *programmatic*
    // focus is a heuristic — so the same tree rendered both ways. Measured over
    // five consecutive captures of one unchanged tree (#11465): the ring was
    // present in 3/5 light renders and 3/5 dark ones, and each presence flipped
    // that view to CHANGED at 0.05%, 2.5x the threshold. All 499 differing
    // pixels were inside the ring's box (x 280-360, y 69-112); the button's own
    // border and label were byte-identical.
    //
    // Asserted as an ordering, like the `freezeWallClock` guard above: moving
    // the call after `captureScreenshot` — or dropping it, since no scenario
    // fails without it — leaves the coin flip in place and every test green.
    // Scoped to the cockpit spec rather than to `captureScreenshot` because a
    // blanket blur moved 11 of 68 views, `slash-menu-dark` by 30.1%.
    const harness = readFileSync(join(VISUALS_DIR, 'harness.ts'), 'utf8');
    expect(harness, 'harness must define clearFocus').toMatch(
      /export async function clearFocus\(/,
    );
    expect(
      harness.slice(
        harness.indexOf('export async function captureScreenshot('),
        harness.indexOf('export async function clearFocus('),
      ),
      'clearFocus must stay opt-in per scenario, not blanket-applied',
    ).not.toMatch(/clearFocus\(page\)/);

    const spec = readFileSync(
      join(VISUALS_DIR, 'session-workflow.spec.ts'),
      'utf8',
    );
    const clearAt = spec.indexOf('await clearFocus(page);');
    const shotAt = spec.indexOf('await captureScreenshot(');
    expect(clearAt, 'the cockpit spec must clear focus').toBeGreaterThan(-1);
    expect(shotAt, 'the cockpit spec must capture').toBeGreaterThan(-1);
    expect(clearAt, 'focus must be cleared before the capture').toBeLessThan(
      shotAt,
    );
  });
  it('keeps the background-dot action hide inside the hover media query', () => {
    // Touch devices get no hover reveal: the (hover: none) block keeps row
    // actions always visible, and this (0,4,0) rule would out-specify it on a
    // sticky tap-hover, hiding (but not disarming) the buttons.
    const css = readFileSync(
      join(HERE, 'components/sidebar/WebShellSidebar.module.css'),
      'utf8',
    );
    const hideRule =
      '.sessionRow:has(.sessionBackgroundRunning:hover) .sessionActions';
    expect(css.indexOf(hideRule)).toBe(css.lastIndexOf(hideRule));
    expect(css, 'the hide rule must live inside @media (hover: hover)').toMatch(
      /@media \(hover: hover\) \{\s*\.sessionRow:has\(\.sessionBackgroundRunning:hover\) \.sessionActions \{/,
    );
  });
});
