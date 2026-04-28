/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { AssistantMessage } from './ConversationMessages.js';

describe('<ConversationMessages />', () => {
  it('does not hide exactly fitting pending assistant output', () => {
    const text = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={6}
        contentWidth={80}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).not.toContain('streaming line');
    expect(output).toContain('line 1');
    expect(output).toContain('line 6');
  });

  it('reserves only the overflow marker row for pending assistant output', () => {
    const text = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={6}
        contentWidth={80}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).toContain('... first 2 streaming lines hidden ...');
    expect(output).not.toContain('line 2');
    expect(output).toContain('line 3');
    expect(output).toContain('line 7');
  });
});
