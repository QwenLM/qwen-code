/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { AutoAcceptIndicator } from './AutoAcceptIndicator.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';

describe('<AutoAcceptIndicator />', () => {
  it('renders DEFAULT mode with pause badge and Ask permissions text', () => {
    const { lastFrame } = render(
      <AutoAcceptIndicator approvalMode={ApprovalMode.DEFAULT} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('⏸');
    expect(frame).toContain('Ask permissions');
  });

  it('renders PLAN mode indicator', () => {
    const { lastFrame } = render(
      <AutoAcceptIndicator approvalMode={ApprovalMode.PLAN} />,
    );
    expect(lastFrame()).toContain('plan mode');
  });

  it('renders AUTO_EDIT mode indicator', () => {
    const { lastFrame } = render(
      <AutoAcceptIndicator approvalMode={ApprovalMode.AUTO_EDIT} />,
    );
    expect(lastFrame()).toContain('auto-accept edits');
  });

  it('renders AUTO mode indicator', () => {
    const { lastFrame } = render(
      <AutoAcceptIndicator approvalMode={ApprovalMode.AUTO} />,
    );
    expect(lastFrame()).toContain('auto mode (classifier-evaluated)');
  });

  it('renders YOLO mode indicator', () => {
    const { lastFrame } = render(
      <AutoAcceptIndicator approvalMode={ApprovalMode.YOLO} />,
    );
    expect(lastFrame()).toContain('YOLO mode');
  });
});
