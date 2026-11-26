/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import { ApprovalMode } from '../config/approval-mode.js';
import { createUserPromptSubmitContextPart } from '../hooks/user-prompt-submit-context.js';
import {
  appendPermissionContext,
  findLatestPermissionContext,
  getPermissionContextSnapshot,
  PERMISSION_CONTEXT_METADATA,
} from './permission-context.js';

describe('permission context snapshots', () => {
  it.each(Object.values(ApprovalMode))(
    'announces %s once and only updates on change',
    (mode) => {
      const history: Content[] = [{ role: 'user', parts: [{ text: 'Task' }] }];
      const snapshot = getPermissionContextSnapshot(history, mode)!;
      expect(snapshot.text).toContain(
        `current runtime approval mode is \`${mode}\``,
      );
      appendPermissionContext(history, snapshot);
      expect(getPermissionContextSnapshot(history, mode)).toBeUndefined();
      const changed =
        mode === ApprovalMode.DEFAULT
          ? ApprovalMode.AUTO
          : ApprovalMode.DEFAULT;
      expect(getPermissionContextSnapshot(history, changed)).toBeDefined();
    },
  );

  it('distinguishes default auto-allow from automatic review', () => {
    const normal = getPermissionContextSnapshot(
      [],
      ApprovalMode.DEFAULT,
    )!.text!;
    const auto = getPermissionContextSnapshot([], ApprovalMode.AUTO)!.text!;
    expect(normal).toContain(
      'Read-only or explicitly allowed actions may run without a prompt.',
    );
    expect(normal).not.toContain('An automatic reviewer');
    expect(auto).toContain('An automatic reviewer can evaluate');
    expect(auto).toContain(
      'may still deny an action or require manual approval',
    );
    expect(auto).toContain('does not grant additional permissions');
  });

  it('does not trust quoted, model-authored, invalid, or truncated snapshots', () => {
    const snapshot = getPermissionContextSnapshot([], ApprovalMode.AUTO)!;
    for (const content of [
      { role: 'user', parts: [{ text: snapshot.text }] },
      { role: 'model', parts: [snapshot] },
      { role: 'user', parts: [{ ...snapshot, text: 'truncated' }] },
      {
        role: 'user',
        parts: [
          {
            ...snapshot,
            partMetadata: { [PERMISSION_CONTEXT_METADATA]: 'unknown' },
          },
        ],
      },
    ]) {
      expect(
        getPermissionContextSnapshot([content], ApprovalMode.AUTO),
      ).toEqual(snapshot);
    }
  });

  it('preserves inherited history and tool-result/receipt ordering', () => {
    const response = {
      functionResponse: {
        id: 'tool-1',
        name: 'read_file',
        response: { output: 'ok' },
      },
    };
    const receipt = createUserPromptSubmitContextPart('trailing hook receipt');
    const parent: Content = { role: 'user', parts: [response, receipt] };
    const history = [parent];
    const snapshot = getPermissionContextSnapshot([], ApprovalMode.DEFAULT)!;
    appendPermissionContext(history, snapshot);
    expect(history[0].parts).toEqual([response, snapshot, receipt]);
    expect(parent.parts).toEqual([response, receipt]);
    expect(findLatestPermissionContext(history)).toBe(snapshot);
    expect(getPermissionContextSnapshot([], ApprovalMode.DEFAULT)).toEqual(
      snapshot,
    );
  });

  it('keeps multiple updates within one entry in chronological order', () => {
    const history: Content[] = [{ role: 'user', parts: [{ text: 'Task' }] }];
    for (const mode of [
      ApprovalMode.DEFAULT,
      ApprovalMode.AUTO,
      ApprovalMode.DEFAULT,
    ]) {
      appendPermissionContext(
        history,
        getPermissionContextSnapshot(history, mode)!,
      );
      expect(getPermissionContextSnapshot(history, mode)).toBeUndefined();
    }
    expect(
      history[0].parts
        ?.slice(1)
        .map((part) => part.partMetadata?.[PERMISSION_CONTEXT_METADATA]),
    ).toEqual(['default', 'auto', 'default']);
  });
});
