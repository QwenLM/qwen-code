/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { visualViewportBottomInset } from './visualViewportInset';

describe('visualViewportBottomInset', () => {
  it('measures keyboard occlusion and honors a scrolled visual viewport', () => {
    expect(
      visualViewportBottomInset(
        { bottom: 664, height: 664 },
        { height: 419, offsetTop: 0, scale: 1 },
      ),
    ).toBe(245);
    expect(
      visualViewportBottomInset(
        { bottom: 664, height: 664 },
        { height: 500, offsetTop: 100, scale: 1 },
      ),
    ).toBe(64);
  });

  it('does not inset an embedded shell that ends above the visible viewport', () => {
    expect(
      visualViewportBottomInset(
        { bottom: 400, height: 400 },
        { height: 437, offsetTop: 0, scale: 1 },
      ),
    ).toBe(0);
  });

  it('never insets more than the shell is tall', () => {
    // A shell shorter than the occluded band (embedded pane, split view) must
    // not lift its composer above its own top edge, so the clamp is part of
    // the contract and not just arithmetic happenstance.
    expect(
      visualViewportBottomInset(
        { bottom: 400, height: 200 },
        { height: 100, offsetTop: 0, scale: 1 },
      ),
    ).toBe(200);
  });

  it('ignores pinch zoom instead of moving the composer', () => {
    expect(
      visualViewportBottomInset(
        { bottom: 664, height: 664 },
        { height: 419, offsetTop: 0, scale: 1.5 },
      ),
    ).toBe(0);
  });
});
