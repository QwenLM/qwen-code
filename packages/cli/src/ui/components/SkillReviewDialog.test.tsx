/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CapturedRadio {
  items?: Array<{ value: string; label: string }>;
  onSelect?: (value: string) => void;
}
const captured: CapturedRadio = {};

// Mock RadioButtonSelect to capture its props so we can drive selections
// directly without simulating keyboard input.
vi.mock('./shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: (props: {
    items: Array<{ value: string; label: string }>;
    onSelect: (value: string) => void;
  }) => {
    captured.items = props.items;
    captured.onSelect = props.onSelect;
    return null;
  },
}));

// Keep keypress handling inert for these tests.
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

import { SkillReviewDialog } from './SkillReviewDialog.js';

describe('SkillReviewDialog', () => {
  const skills = [
    { name: 'auto-skill-alpha', description: 'does alpha' },
    { name: 'auto-skill-beta', description: 'does beta' },
  ];

  beforeEach(() => {
    captured.items = undefined;
    captured.onSelect = undefined;
  });

  it('renders the first pending skill name and description with a counter', () => {
    const { lastFrame } = render(
      <SkillReviewDialog
        skills={skills}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('auto-skill-alpha');
    expect(lastFrame()).toContain('does alpha');
    expect(lastFrame()).toContain('1/2');
  });

  it('offers keep / discard / keep-all / discard-all options', () => {
    render(
      <SkillReviewDialog
        skills={skills}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const values = (captured.items ?? []).map((i) => i.value);
    expect(values).toEqual(['keep', 'discard', 'keepAll', 'discardAll']);
  });

  it('keep accepts the current skill and does NOT close while more remain', () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    render(
      <SkillReviewDialog
        skills={skills}
        onAccept={onAccept}
        onReject={vi.fn()}
        onClose={onClose}
        onDismiss={vi.fn()}
      />,
    );
    captured.onSelect!('keep');
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keep on the last remaining skill closes the dialog', () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    render(
      <SkillReviewDialog
        skills={[skills[0]!]}
        onAccept={onAccept}
        onReject={vi.fn()}
        onClose={onClose}
        onDismiss={vi.fn()}
      />,
    );
    captured.onSelect!('keep');
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keepAll accepts every remaining skill then closes once', () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    render(
      <SkillReviewDialog
        skills={skills}
        onAccept={onAccept}
        onReject={vi.fn()}
        onClose={onClose}
        onDismiss={vi.fn()}
      />,
    );
    captured.onSelect!('keepAll');
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onAccept).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onAccept).toHaveBeenCalledWith('auto-skill-beta');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('discardAll rejects every remaining skill then closes once', () => {
    const onReject = vi.fn();
    const onClose = vi.fn();
    render(
      <SkillReviewDialog
        skills={skills}
        onAccept={vi.fn()}
        onReject={onReject}
        onClose={onClose}
        onDismiss={vi.fn()}
      />,
    );
    captured.onSelect!('discardAll');
    expect(onReject).toHaveBeenCalledTimes(2);
    expect(onReject).toHaveBeenCalledWith('auto-skill-alpha');
    expect(onReject).toHaveBeenCalledWith('auto-skill-beta');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing and closes when there are no skills', async () => {
    const onClose = vi.fn();
    const { lastFrame } = render(
      <SkillReviewDialog
        skills={[]}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClose={onClose}
        onDismiss={vi.fn()}
      />,
    );
    expect(lastFrame()).toBe('');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
