/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { AgentFooter } from './AgentFooter.js';

describe('AgentFooter', () => {
  it.each([false, true])(
    'preserves the cycle hint and context usage (showMode=%s)',
    (showApprovalMode) => {
      const { lastFrame } = render(
        <AgentFooter
          approvalMode={ApprovalMode.YOLO}
          showApprovalMode={showApprovalMode}
          promptTokenCount={100}
          contextWindowSize={1000}
          terminalWidth={100}
        />,
      );
      expect(lastFrame()).toContain('tab to cycle');
      expect(lastFrame()).toContain('10.0% context used');
      expect(lastFrame()?.includes('YOLO mode')).toBe(showApprovalMode);
    },
  );
});
