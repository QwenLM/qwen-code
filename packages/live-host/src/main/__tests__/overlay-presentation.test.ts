import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { OVERLAY_GEOMETRY } from '../../shared/overlay-geometry.ts';

const css = readFileSync(
  new URL('../../renderer/style.css', import.meta.url),
  'utf8',
);
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, `Missing style rule: ${selector}`);
  return match[1]!;
};

describe('orb presentation geometry', () => {
  it('keeps hover controls above the animation and status below, with both inside edge bounds', () => {
    const { toolbar, orbMotion, status, bounds, caption, previewWithCaption } =
      OVERLAY_GEOMETRY;
    assert(toolbar.y + toolbar.height <= orbMotion.y);
    assert(status.y >= orbMotion.y + orbMotion.height + 4);
    assert(previewWithCaption.y + previewWithCaption.height < caption.y);
    for (const envelope of [bounds.orb, bounds['orb-preview']]) {
      for (const rect of [toolbar, orbMotion, status]) {
        assert(rect.x >= envelope.x && rect.y >= envelope.y);
        assert(rect.x + rect.width <= envelope.x + envelope.width);
        assert(rect.y + rect.height <= envelope.y + envelope.height);
      }
    }
  });

  it('uses a translucent status surface and a round settings button', () => {
    assert.match(
      rule('.voice-status'),
      /background:\s*var\(--live-status-bg\)/,
    );
    assert.match(
      rule('.voice-controls .settings-control'),
      /border-radius:\s*50%/,
    );
  });

  it('lets the full status receive hover and keeps stopping visually idle', () => {
    assert.match(rule('.voice-status-primary'), /pointer-events:\s*auto/);
    assert.match(
      css,
      /\.voice-orb\.idle \.orb-core,\s*\.voice-orb\.stopping \.orb-core,/,
    );
  });

  it('overrides state-specific orb animations and input scaling under reduced motion', () => {
    const reduced = css.slice(
      css.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    assert.match(
      reduced,
      /\.voice-surface \.voice-orb \.orb-core,\s*\.voice-surface \.voice-orb \.orb-core::after\s*\{\s*animation:\s*none;\s*transform:\s*none;/,
    );
  });

  it('fits persistent mute indicators below the primary status without increasing the orb bounds', () => {
    assert.match(rule('.voice-status'), /flex-direction:\s*column/);
    assert.match(rule('.voice-status-audio'), /line-height:\s*11px/);
    assert.match(rule('.voice-status-audio'), /flex-shrink:\s*0/);
    assert.match(
      rule('.voice-status.has-audio-status .voice-status-primary'),
      /max-height:\s*14px/,
    );
    assert.match(
      rule('.voice-status.has-audio-status .voice-status-primary'),
      /text-overflow:\s*ellipsis/,
    );
    assert.doesNotMatch(rule('.permission-link'), /position:\s*absolute/);
    assert(14 + 11 + 4 <= OVERLAY_GEOMETRY.status.height);
  });

  it('reserves and paints the Settings scrollbar without waiting for hover', () => {
    assert.match(rule('.settings-body'), /overflow-y:\s*scroll/);
    assert.match(rule('.settings-body'), /scrollbar-gutter:\s*stable/);
    assert.match(rule('.settings-body::-webkit-scrollbar'), /width:\s*8px/);
    assert.match(
      rule('.settings-body::-webkit-scrollbar-track'),
      /background:/,
    );
    assert.match(
      rule('.settings-body::-webkit-scrollbar-thumb'),
      /background:/,
    );
  });

  it('constrains translated or long Settings content without widening the panel', () => {
    assert.match(
      rule('.settings-layer'),
      /grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    assert.match(
      rule('.settings-layer'),
      /grid-template-rows:\s*minmax\(0, 1fr\)/,
    );
    assert.match(rule('.settings-panel'), /min-width:\s*0/);
    assert.match(rule('.settings-body'), /min-width:\s*0/);
    assert.match(rule('.settings-panel > header'), /flex-shrink:\s*0/);
  });

  it('fits the listening gain and animated outline into the reserved motion envelope', () => {
    assert.match(
      rule('.voice-orb.listening .orb-core::after'),
      /inset:\s*-1px/,
    );
    assert(
      (OVERLAY_GEOMETRY.orb.width + 2) * 1.3 * 1.04 <
        OVERLAY_GEOMETRY.orbMotion.width,
    );
  });
});
