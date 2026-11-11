/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getConfirmationOptions,
  TYPE_SOMETHING_VALUE,
  VIEW_WORKFLOW_SCRIPT_VALUE,
} from './confirmationOptions.js';
import {
  type SerializableConfirmationDetails,
  ToolConfirmationOutcome,
} from '@qwen-code/core';

describe('getConfirmationOptions', () => {
  describe('file_read', () => {
    const details: SerializableConfirmationDetails = {
      type: 'file_read',
      title: 'Read src/app.ts',
      filePath: '/workspace/src/app.ts',
      displayPath: 'src/app.ts',
    };

    it('returns Allow once, Allow session, Reject, and No options', () => {
      const options = getConfirmationOptions(details);

      expect(options).toHaveLength(4);
      expect(options.map((o) => o.value)).toEqual([
        ToolConfirmationOutcome.ProceedOnce,
        ToolConfirmationOutcome.ProceedSession,
        TYPE_SOMETHING_VALUE,
        ToolConfirmationOutcome.Cancel,
      ]);
    });

    it('includes session-allow with correct label', () => {
      const options = getConfirmationOptions(details);
      const sessionOption = options.find(
        (o) => o.value === ToolConfirmationOutcome.ProceedSession,
      );
      expect(sessionOption?.label).toBe('Allow for this session');
    });
  });

  describe('repeated_tool_call', () => {
    const details: SerializableConfirmationDetails = {
      type: 'repeated_tool_call',
      title: 'Repeated tool call detected',
      toolName: 'Read',
      repeatCount: 3,
      threshold: 3,
      inputPreview: '{"file_path":"/same.txt"}',
    };

    it('returns Continue once, Always exact call, and Stop options', () => {
      const options = getConfirmationOptions(details);

      expect(options).toHaveLength(3);
      expect(options.map((o) => o.value)).toEqual([
        ToolConfirmationOutcome.ProceedOnce,
        ToolConfirmationOutcome.ProceedSession,
        ToolConfirmationOutcome.Cancel,
      ]);
      expect(options.map((o) => o.label)).toEqual([
        'Continue once',
        'Always continue this exact call',
        'Stop',
      ]);
    });
  });

  describe('workflow', () => {
    const details: SerializableConfirmationDetails = {
      type: 'workflow',
      title: 'Run a dynamic workflow?',
      workflowName: 'audit',
      source: 'inline',
    };

    it('returns Run, View raw script, Reject, and No options', () => {
      const options = getConfirmationOptions(details);

      expect(options).toHaveLength(4);
      expect(options.map((o) => o.value)).toEqual([
        ToolConfirmationOutcome.ProceedOnce,
        VIEW_WORKFLOW_SCRIPT_VALUE,
        TYPE_SOMETHING_VALUE,
        ToolConfirmationOutcome.Cancel,
      ]);
      expect(options.map((o) => o.label)).toEqual([
        'Run',
        'View raw script',
        'Reject and type something',
        'No',
      ]);
    });
  });

  describe('video', () => {
    const details: SerializableConfirmationDetails = {
      type: 'video',
      title: 'Generate video',
      prompt: 'a puppy running',
      mode: 'text_to_video',
      size: '1280x720',
    };

    it('offers Generate, Reject-and-type, and No — the dialog was once actionless', () => {
      const options = getConfirmationOptions(details);

      expect(options.map((o) => o.value)).toEqual([
        ToolConfirmationOutcome.ProceedOnce,
        TYPE_SOMETHING_VALUE,
        ToolConfirmationOutcome.Cancel,
      ]);
      expect(options.map((o) => o.label)).toEqual([
        'Generate',
        'Reject and type something',
        'No',
      ]);
    });

    it('offers no remember-scope shortcut on a cost gate', () => {
      const options = getConfirmationOptions(details);

      expect(
        options.map((o) => o.value),
      ).not.toContain(ToolConfirmationOutcome.ProceedSession);
      expect(
        options.map((o) => o.value),
      ).not.toContain(ToolConfirmationOutcome.ProceedPersist);
    });
  });
});

describe('exec without a persist option', () => {
  it('omits "always allow" when the prompt is not persistable', () => {
    const details: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'rm -rf ~',
      command: 'rm -rf ~',
      rootCommand: 'rm',
      rootCommands: ['rm'],
      persistable: false,
    };
    const options = getConfirmationOptions(details);
    expect(options.map((o) => o.value)).not.toContain(
      ToolConfirmationOutcome.ProceedPersist,
    );
    expect(options.map((o) => o.value)).toContain(
      ToolConfirmationOutcome.ProceedOnce,
    );
  });
});
