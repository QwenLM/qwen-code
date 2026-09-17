import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { OVERLAY_GEOMETRY } from '../../shared/overlay-geometry.ts';

const css = readFileSync(
  new URL('../../renderer/style.css', import.meta.url),
  'utf8',
);
type Rect = { x: number; y: number; width: number; height: number };
function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

describe('Pebble presentation geometry', () => {
  it('matches the selected card, disc, preview and settings dimensions', () => {
    const { card, orb, settings, preview } = OVERLAY_GEOMETRY;
    assert.deepEqual([card.width, card.height], [234, 194]);
    assert.deepEqual([orb.width, orb.height], [51, 51]);
    assert.deepEqual([preview.width, preview.height], [161, 107]);
    assert.deepEqual([settings.width, settings.height], [306, 532]);
  });
  it('keeps controls inside the card and reserves separate space for captions, preview, summary and settings', () => {
    const {
      card,
      toolbar,
      orb,
      status,
      header,
      summary,
      caption,
      previewWithCaption,
      settings,
      settingsBounds,
      bounds,
    } = OVERLAY_GEOMETRY;
    for (const rect of [toolbar, orb, status, header])
      assert(contains(card, rect));
    assert.equal(toolbar.y - card.y, 116);
    assert.equal(orb.x - card.x, 18);
    assert.equal(orb.y - card.y, 47);
    assert.equal(summary.y - card.y - card.height, 13);
    assert.equal(
      caption.y - previewWithCaption.y - previewWithCaption.height,
      10,
    );
    assert.equal(card.y - caption.y - caption.height, 7);
    assert(settings.x > card.x + card.width);
    for (const rect of [card, summary, caption, settings, previewWithCaption])
      assert(contains(settingsBounds, rect));
    for (const rect of [card, summary, caption])
      assert(contains(bounds.orb, rect));
    assert(contains(bounds['orb-preview'], previewWithCaption));
  });
  it('uses tokenized materials, persistent controls and bounded scrollable settings', () => {
    assert.match(css, /border-radius: 26px/);
    assert.match(css, /backdrop-filter: blur\(16px\)/);
    assert.doesNotMatch(
      css,
      /controls-visible|visibility: hidden|--input-scale/,
    );
    assert.match(css, /\.settings-body\s*\{[^}]*overflow-y: auto/);
    assert.match(css, /\.settings-panel\s*\{[^}]*pointer-events: auto/);
    assert.match(css, /\.settings-layer\s*\{[^}]*pointer-events: none/);
  });
  it('disables animation and bar transforms under reduced motion', () => {
    const reduced = css.slice(
      css.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    assert.match(reduced, /animation: none !important/);
    assert.match(reduced, /\.voice-wave i\s*\{[^}]*transform: none !important/);
  });
});
