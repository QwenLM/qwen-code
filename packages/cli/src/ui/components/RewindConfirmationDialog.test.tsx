/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RewindConfirmationDialog } from './RewindConfirmationDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('./shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: vi.fn(() => null),
}));

const mockedUseKeypress = vi.mocked(useKeypress);
const mockedSelect = vi.mocked(DescriptiveRadioButtonSelect);

function createEntry(hasChanges: boolean) {
  return {
    key: 'node-1',
    kind: 'node' as const,
    label: 'write a small python script to create a test',
    timestamp: '2025-01-01T00:00:00.000Z',
    node: {
      uuid: 'node-1',
      parentUuid: 'parent-1',
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      prompt: 'write a small python script to create a test',
    },
    codeSummary: hasChanges
      ? {
          hasChanges: false,
          summaryText: 'No code changes',
          detailText: 'The code will be unchanged.',
          changes: [],
        }
      : {
          hasChanges: false,
          summaryText: 'No code changes',
          detailText: 'The code will be unchanged.',
          changes: [],
        },
    restoreCodeSummary: hasChanges
      ? {
          hasChanges: true,
          summaryText: 'test_sensitivity_rules.py +91 -0',
          detailText:
            'The code will be restored +91 -0 in test_sensitivity_rules.py.',
          changes: [
            {
              path: 'test_sensitivity_rules.py',
              additions: 91,
              deletions: 0,
            },
          ],
          checkpointCommitHash: 'snapshot-1',
        }
      : {
          hasChanges: false,
          summaryText: 'No code changes',
          detailText: 'The code will be unchanged.',
          changes: [],
        },
  };
}

describe('RewindConfirmationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows all restore options when code changed', () => {
    render(
      <RewindConfirmationDialog
        entry={createEntry(true)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items.map((item) => item.value)).toEqual([
      'restore_code_and_conversation',
      'restore_conversation',
      'restore_code',
      'summarize_from_here',
      'cancel',
    ]);
    expect(screen.getByText('The conversation will be forked.')).toBeDefined();
    expect(
      screen.getByText(
        'The code will be restored +91 -0 in test_sensitivity_rules.py.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        'Rewinding does not affect files edited manually or via bash.',
      ),
    ).toBeDefined();
  });

  it('omits code restore options when there are no code changes', () => {
    render(
      <RewindConfirmationDialog
        entry={createEntry(false)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items.map((item) => item.value)).toEqual([
      'restore_conversation',
      'summarize_from_here',
      'cancel',
    ]);
  });

  it('updates preview text when a different action is highlighted', () => {
    render(
      <RewindConfirmationDialog
        entry={createEntry(true)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const onHighlight = mockedSelect.mock.calls[0][0].onHighlight;
    expect(onHighlight).toBeDefined();

    act(() => {
      onHighlight?.('restore_code');
    });

    expect(
      screen.getByText('The conversation will be unchanged.'),
    ).toBeDefined();
    expect(
      screen.getByText(
        'The code will be restored +91 -0 in test_sensitivity_rules.py.',
      ),
    ).toBeDefined();
  });

  it('forwards selected actions and escape cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <RewindConfirmationDialog
        entry={createEntry(true)}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const onSelect = mockedSelect.mock.calls[0][0].onSelect;
    act(() => {
      onSelect('summarize_from_here');
    });
    expect(onConfirm).toHaveBeenCalledWith('summarize_from_here');

    const keyHandler = mockedUseKeypress.mock.calls[0][0];
    act(() => {
      keyHandler({
        name: 'escape',
        ctrl: false,
        meta: false,
        shift: false,
        paste: false,
        sequence: '',
      });
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
