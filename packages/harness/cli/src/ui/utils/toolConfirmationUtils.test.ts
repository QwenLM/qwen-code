/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isOwnUITool,
  getConfirmationTitle,
  isCompletedAskUserTool,
} from './toolConfirmationUtils.js';
import {
  ASK_USER_TOOL_NAME,
  ASK_USER_DISPLAY_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';

describe('isOwnUITool', () => {
  it('returns true for AskUserQuestion', () => {
    expect(isOwnUITool(ASK_USER_TOOL_NAME)).toBe(true);
  });

  it('returns true for ExitPlanMode', () => {
    expect(isOwnUITool(EXIT_PLAN_MODE_TOOL_NAME)).toBe(true);
  });

  it('returns false for other types', () => {
    expect(isOwnUITool('exec')).toBe(false);
    expect(isOwnUITool('edit')).toBe(false);
  });
});

describe('getConfirmationTitle', () => {
  it('returns "Answer Questions" for AskUser', () => {
    expect(
      getConfirmationTitle({
        type: ASK_USER_TOOL_NAME,
      } as SerializableConfirmationDetails),
    ).toBe('Answer Questions');
  });

  it('returns plan mode title for ExitPlanMode', () => {
    expect(
      getConfirmationTitle({
        type: EXIT_PLAN_MODE_TOOL_NAME,
      } as SerializableConfirmationDetails),
    ).toBe('Ready to start implementation?');
  });

  it('returns "Permission Required" for other types', () => {
    expect(
      getConfirmationTitle({ type: 'exec' } as SerializableConfirmationDetails),
    ).toBe('Permission Required');
  });

  it('returns "Permission Required" for undefined', () => {
    expect(getConfirmationTitle(undefined)).toBe('Permission Required');
  });
});

describe('isCompletedAskUserTool', () => {
  it('returns false for non-AskUser tools', () => {
    expect(isCompletedAskUserTool('other-tool', 'Success')).toBe(false);
  });

  it('returns true for Success status', () => {
    expect(isCompletedAskUserTool(ASK_USER_DISPLAY_NAME, 'Success')).toBe(true);
  });

  it('returns true for Error status', () => {
    expect(isCompletedAskUserTool(ASK_USER_DISPLAY_NAME, 'Error')).toBe(true);
  });

  it('returns true for Canceled status', () => {
    expect(isCompletedAskUserTool(ASK_USER_DISPLAY_NAME, 'Canceled')).toBe(
      true,
    );
  });

  it('returns false for in-progress statuses', () => {
    expect(isCompletedAskUserTool(ASK_USER_DISPLAY_NAME, 'Executing')).toBe(
      false,
    );
    expect(isCompletedAskUserTool(ASK_USER_DISPLAY_NAME, 'Pending')).toBe(
      false,
    );
  });
});
