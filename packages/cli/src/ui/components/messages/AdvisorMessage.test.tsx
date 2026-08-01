/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { AdvisorMessage } from './AdvisorMessage.js';

describe('AdvisorMessage', () => {
  it('is wrapped in React.memo to avoid unnecessary layout rerenders', () => {
    expect((AdvisorMessage as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('renders the resolved model in the header and the review body', () => {
    const { lastFrame } = renderWithProviders(
      <AdvisorMessage
        text={'## Verdict\nThe approach is sound.'}
        model="qwen3-max"
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('/advisor');
    expect(output).toContain('qwen3-max');
    expect(output).toContain('Verdict');
    expect(output).toContain('The approach is sound.');
  });

  it('accepts containerWidth prop for content width calculation', () => {
    const { lastFrame } = renderWithProviders(
      <AdvisorMessage text="review body" model="m" containerWidth={60} />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('review body');
  });
});
