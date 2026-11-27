/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  REPEATED_TOOL_CALL_PERMISSION_KIND,
  ToolConfirmationOutcome,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { getCanUseToolPresentation } from './canUseToolPresentation.js';

describe('getCanUseToolPresentation', () => {
  it('retains one-shot choices when rich confirmation details are unavailable', () => {
    expect(getCanUseToolPresentation(undefined, false).options?.map((option) => option.outcome)).toEqual(['proceed_once', 'cancel']);
    expect(getCanUseToolPresentation(undefined)).toEqual({});
  });

  it('projects Bash choices without inventing a session option', () => {
    const details: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Run shell command?',
      command: 'npm test',
      rootCommand: 'npm',
      rootCommands: ['npm'],
      isCompound: false,
    };

    expect(getCanUseToolPresentation(details)).toEqual({
      options: [
        {
          outcome: ToolConfirmationOutcome.ProceedOnce,
          name: 'Allow once',
          allowed: true,
        },
        {
          outcome: ToolConfirmationOutcome.ProceedPersist,
          name: 'Always allow "npm" for future sessions',
          allowed: true,
        },
        {
          outcome: ToolConfirmationOutcome.Cancel,
          name: 'No',
          allowed: false,
        },
      ],
    });
  });

  it('preserves the existing Read session option', () => {
    const details: SerializableConfirmationDetails = {
      type: 'file_read',
      title: 'Read file?',
      filePath: '/workspace/README.md',
      displayPath: 'README.md',
    };

    expect(getCanUseToolPresentation(details).options).toEqual(
      expect.arrayContaining([
        {
          outcome: ToolConfirmationOutcome.ProceedSession,
          name: 'Allow for this session',
          allowed: true,
        },
      ]),
    );
  });

  it('projects DoomLoop semantics and excludes no options', () => {
    const details: SerializableConfirmationDetails = {
      type: REPEATED_TOOL_CALL_PERMISSION_KIND,
      title: 'Repeated tool call detected',
      toolName: 'Bash',
      repeatCount: 5,
      threshold: 5,
      inputPreview: '{"command":"npm test"}',
    };

    expect(getCanUseToolPresentation(details)).toEqual({
      permission_kind: REPEATED_TOOL_CALL_PERMISSION_KIND,
      options: [
        {
          outcome: ToolConfirmationOutcome.ProceedOnce,
          name: 'Continue once',
          allowed: true,
        },
        {
          outcome: ToolConfirmationOutcome.ProceedSession,
          name: 'Always continue this exact call',
          allowed: true,
        },
        {
          outcome: ToolConfirmationOutcome.Cancel,
          name: 'Stop',
          allowed: false,
        },
      ],
    });
  });

  it('returns no synthetic fallback when details are unavailable', () => {
    expect(getCanUseToolPresentation(undefined)).toEqual({});
  });
});
