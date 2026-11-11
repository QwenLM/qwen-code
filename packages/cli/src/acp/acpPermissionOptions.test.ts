/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { toPermissionOptions } from './acpSupport.js';
import {
  type SerializableConfirmationDetails,
  ToolConfirmationOutcome,
} from '@qwen-code/core';

describe('toPermissionOptions', () => {
  it('handles file_read without throwing (exhaustive switch coverage)', () => {
    const details: SerializableConfirmationDetails = {
      type: 'file_read',
      title: 'Read src/app.ts',
      filePath: '/workspace/src/app.ts',
      displayPath: 'src/app.ts',
    };

    const options = toPermissionOptions(details);

    // Should include session-allow option + basic options (allow once, reject)
    const sessionOption = options.find(
      (o) => o.optionId === ToolConfirmationOutcome.ProceedSession,
    );
    expect(sessionOption).toBeDefined();
    expect(sessionOption!.name).toBe('Allow for this session');
    expect(sessionOption!.kind).toBe('allow_always');
  });

  it('includes basic allow/reject options for file_read', () => {
    const details: SerializableConfirmationDetails = {
      type: 'file_read',
      title: 'Read src/app.ts',
      filePath: '/workspace/src/app.ts',
      displayPath: 'src/app.ts',
    };

    const options = toPermissionOptions(details);

    const allowOnce = options.find(
      (o) => o.optionId === ToolConfirmationOutcome.ProceedOnce,
    );
    const reject = options.find(
      (o) => o.optionId === ToolConfirmationOutcome.Cancel,
    );
    expect(allowOnce).toBeDefined();
    expect(reject).toBeDefined();
  });

  it('includes session exact-call option for repeated_tool_call', () => {
    const details: SerializableConfirmationDetails = {
      type: 'repeated_tool_call',
      title: 'Repeated tool call detected',
      toolName: 'Read',
      repeatCount: 3,
      threshold: 3,
      inputPreview: '{"file_path":"/same.txt"}',
    };

    const options = toPermissionOptions(details);

    expect(options.map((option) => option.optionId)).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.ProceedSession,
      ToolConfirmationOutcome.Cancel,
    ]);
    expect(options[0]).toMatchObject({
      name: 'Allow',
      kind: 'allow_once',
    });
    expect(options[1]).toMatchObject({
      name: 'Always continue this exact call',
      kind: 'allow_always',
    });
  });

  it('only offers one-shot allow/reject options for workflow approvals', () => {
    const details: SerializableConfirmationDetails = {
      type: 'workflow',
      title: 'Run a dynamic workflow?',
      workflowName: 'audit',
      source: 'inline',
      script: 'export const meta = { name: "audit", description: "Audit" };',
    };

    const options = toPermissionOptions(details);

    expect(options.map((option) => option.optionId)).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.Cancel,
    ]);
    expect(options).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedSession,
        }),
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedPersist,
        }),
      ]),
    );
  });
});
