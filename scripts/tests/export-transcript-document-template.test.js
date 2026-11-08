/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const template = readFileSync(
  join(
    root,
    'packages',
    'web-templates',
    'src',
    'export-html',
    'src',
    'document-index.html',
  ),
  'utf8',
);

const STYLESHEET_ID = 'id="transcript-stylesheet"';

/**
 * The id the `<link>` actually carries, read back out of the template rather
 * than hard-coded. The same literal is spelled in three places — declared on
 * the `<link>`, compared by the `<head>` latch, compared by the body listener
 * — so deriving it here is what lets one test pin all three against each other.
 */
const STYLESHEET_LINK_ID = /<link[^>]*\bid="([^"]+)"/.exec(template)?.[1];

/** The <head> script that records a stylesheet failure before the <link>. */
function latchScript() {
  const latch = template.indexOf('window.__transcriptStyleFailed = true');
  expect(latch).toBeGreaterThan(-1);
  const start = template.lastIndexOf('<script', latch);
  const end = template.indexOf('</script>', latch);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(latch);
  return template.slice(start, end);
}

// The split stylesheet fails closed through a `window` error listener that the
// body script registers. Chromium parser-blocks that script on the pending
// stylesheet, so on a large document a CSS failure that settles first is
// dispatched while no listener exists yet: nothing marks the render as failed,
// both document-main.tsx guards pass, and the transcript renders completely
// unstyled while stamping data-render-complete="true". The head latch is what
// closes that window, and its *position* is the whole fix — these assertions
// pin the position, the CSP nonce and the record-only shape.
describe('export transcript document template', () => {
  it('latches stylesheet failures in <head>, ahead of the <link>', () => {
    const stylesheet = template.indexOf(STYLESHEET_ID);
    const bodyStart = template.indexOf('<body>');
    const latchStart = template.indexOf(
      'window.__transcriptStyleFailed = true',
    );
    expect(stylesheet).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(-1);
    expect(latchStart).toBeGreaterThan(-1);
    expect(template.lastIndexOf('<script', latchStart)).toBeLessThan(
      stylesheet,
    );
    expect(latchStart).toBeLessThan(bodyStart);
  });

  it('nonces the latch script, because the CSP allows no inline script', () => {
    expect(latchScript()).toContain('nonce="__EXPORT_NONCE__"');
    expect(template).toMatch(/script-src 'nonce-__EXPORT_NONCE__'/);
    expect(template).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(template).not.toMatch(/script-src[^;]*'unsafe-hashes'/);
  });

  it('listens for error in the capture phase, which <link> failures need', () => {
    // Resource error events do not bubble, so a bubble-phase listener on window
    // never sees the stylesheet failure.
    expect(latchScript()).toMatch(
      /window\.addEventListener\(\s*'error',[\s\S]*?\n\s*true,?\s*\);/,
    );
  });

  it('only records the failure while the parser is still in <head>', () => {
    // showLoadError() writes document.body.dataset and #app; neither exists
    // before the parser leaves <head>, so the latch must not call it.
    const script = latchScript();
    expect(script).not.toContain('document.body');
    expect(script).not.toContain('showLoadError');
  });

  it('acts on the latch from the body script', () => {
    const consumed = template.indexOf('if (window.__transcriptStyleFailed)');
    expect(consumed).toBeGreaterThan(template.indexOf('<body>'));
    expect(consumed).toBeGreaterThan(template.indexOf(STYLESHEET_ID));
    expect(template.slice(consumed, consumed + 120)).toContain(
      'showLoadError();',
    );
  });

  it('compares the failing element id both listeners agree on', () => {
    // Without this, one character of drift is invisible: the position, nonce,
    // capture-phase and record-only assertions above all still pass if either
    // listener compares against a different id, and the latch then records
    // nothing — which is R1-2 reinstated with a green suite.
    expect(STYLESHEET_LINK_ID).toBe('transcript-stylesheet');
    expect(latchScript()).toContain(
      `event.target.id === '${STYLESHEET_LINK_ID}'`,
    );
    const bodyListener = template.slice(template.indexOf('<body>'));
    expect(bodyListener).toContain(
      `event.target.id === '${STYLESHEET_LINK_ID}'`,
    );
  });
});
