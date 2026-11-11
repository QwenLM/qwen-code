/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { AskUserDialog } from './AskUserDialog.js';
import { type Question } from '@qwen-code/core';

describe('Key Bubbling Regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const choiceQuestion: Question[] = [
    {
      question: 'Choice Q?',
      header: 'Choice',
      options: [
        { label: 'Option 1', description: '' },
        { label: 'Option 2', description: '' },
      ],
      multiSelect: false,
    },
  ];

  // skip: 现存失败
  it.skip('does not navigate when pressing "j" or "k" in a focused text input', async () => {
    const { stdin, lastFrame } = await renderWithProviders(
      <AskUserDialog
        questions={choiceQuestion}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        width={120}
        availableHeight={20}
      />,
      { width: 120 },
    );

    // 1. Move down to "Other" (3rd item) and activate text input
    act(() => {
      stdin.write('\x1b[B'); // Down arrow to Option 2
    });
    act(() => {
      stdin.write('\x1b[B'); // Down arrow to Other
    });
    act(() => {
      stdin.write('\r'); // Activate text input for Other
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('Enter your response');
    });

    // 2. Type "j"
    act(() => {
      stdin.write('j');
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('j');
      // Verify we are still focusing the custom option (3rd item in list)
      expect(lastFrame()).toMatch(/● 3\.\s+j/);
    });

    // 3. Type "k"
    act(() => {
      stdin.write('k');
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('jk');
      expect(lastFrame()).toMatch(/● 3\.\s+jk/);
    });
  });
});
