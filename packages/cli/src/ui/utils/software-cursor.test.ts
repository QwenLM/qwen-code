/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getSoftwareCursorBackground,
  renderSoftwareCursor,
} from './software-cursor.js';

describe('renderSoftwareCursor', () => {
  it('uses a dark cursor background on light themes', () => {
    expect(getSoftwareCursorBackground('#FAFAFA')).toBe('#3A3A3A');
  });

  it('uses a light cursor background on dark themes', () => {
    expect(getSoftwareCursorBackground('#002b36')).toBe('#D4D4D4');
  });

  it('handles named ANSI theme background colors', () => {
    expect(getSoftwareCursorBackground('white')).toBe('#3A3A3A');
    expect(getSoftwareCursorBackground('black')).toBe('#D4D4D4');
  });

  it('falls back to a light cursor background when the theme background is unknown', () => {
    expect(getSoftwareCursorBackground('')).toBe('#D4D4D4');
  });

  it('uses an explicit background instead of reverse-video styling', () => {
    const rendered = renderSoftwareCursor('x');

    expect(rendered).toContain('x');
    expect(rendered).not.toContain('\u001b[7m');
  });

  it('does not reset the surrounding foreground color', () => {
    const rendered = renderSoftwareCursor('x');

    expect(rendered).not.toContain('\u001b[39m');
  });

  it('renders an empty cursor cell as a space', () => {
    expect(renderSoftwareCursor('')).toContain(' ');
  });
});
