/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { RenderModeProvider } from '../../contexts/RenderModeContext.js';
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

  it('lays out content at containerWidth, not terminal width', () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      configurable: true,
    });
    try {
      const { lastFrame } = renderWithProviders(
        <AdvisorMessage
          text={'```\n' + 'x'.repeat(80) + '\n```'}
          model="m"
          containerWidth={30}
        />,
      );

      const output = lastFrame() ?? '';
      // contentWidth derives from containerWidth (30 - 4 chrome = 26), so the
      // 80-char code line wraps near 26 chars. Ignoring the prop would lay it
      // out at the 80-column terminal width (76 chars) instead.
      expect(output).toContain('x'.repeat(20));
      expect(output).not.toContain('x'.repeat(40));
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, 'columns', original);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)[
          'columns'
        ];
      }
    }
  });

  it('falls back to terminal width when containerWidth is omitted', () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
      value: 40,
      configurable: true,
    });
    try {
      const { lastFrame } = renderWithProviders(
        <AdvisorMessage text={'```\n' + 'x'.repeat(80) + '\n```'} model="m" />,
      );

      const output = lastFrame() ?? '';
      // contentWidth derives from the terminal (40 - 4 chrome = 36), so the
      // 80-char code line wraps well below 40 chars per line. Without the
      // fallback the box would lay out at the full test-stdout width and a
      // single line of x's would far exceed the terminal width.
      expect(output).toContain('x'.repeat(20));
      expect(output).not.toContain('x'.repeat(40));
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, 'columns', original);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)[
          'columns'
        ];
      }
    }
  });

  it('normalizes code fences emitted immediately after prose', () => {
    const { lastFrame } = renderWithProviders(
      <AdvisorMessage text={'Intro```ts\nconst answer = 42;\n```'} model="m" />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('const answer = 42;');
    expect(output).not.toContain('Intro```ts');
  });

  it('repairs fences inside $$ regions in raw mode (mathFences off)', () => {
    const { lastFrame } = renderWithProviders(
      <RenderModeProvider
        value={{ renderMode: 'raw', setRenderMode: () => {} }}
      >
        <AdvisorMessage
          text={'Intro\n$$\nA```ts\ncode\n```\n$$\nAfter.'}
          model="m"
        />
      </RenderModeProvider>,
    );

    const output = lastFrame() ?? '';
    // Raw mode never opens math blocks, so the normalizer must repair the
    // fence inside the $$ region; skipping it would leave 'A```ts' glued.
    expect(output).not.toContain('A```ts');
    expect(output).toContain('code');
  });

  it('leaves $$ regions intact in render mode (mathFences on)', () => {
    const { lastFrame } = renderWithProviders(
      <RenderModeProvider
        value={{ renderMode: 'render', setRenderMode: () => {} }}
      >
        <AdvisorMessage text={'$$\n```\n$$\nLater```ts\nx\n```'} model="m" />
      </RenderModeProvider>,
    );

    const output = lastFrame() ?? '';
    // Render mode honors $$ fences: the region passes through as a math
    // block and only the fence after it gets its newline.
    expect(output).not.toContain('Later```ts');
    expect(output).toContain('Later');
  });
});
