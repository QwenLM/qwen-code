/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { RenderInline } from './InlineMarkdownRenderer.js';

describe('<RenderInline />', () => {
  it('leaves shell-style dollar variables untouched by default', () => {
    const { lastFrame } = renderWithProviders(
      <RenderInline text="echo $HOME && echo $PATH" />,
    );

    expect(lastFrame()).toContain('echo $HOME && echo $PATH');
  });

  it('renders inline math only when explicitly enabled', () => {
    const { lastFrame } = renderWithProviders(
      <RenderInline text="value $\\alpha$" enableInlineMath />,
    );

    expect(lastFrame()).toContain('α');
    expect(lastFrame()).not.toContain('$\\alpha$');
  });
});
