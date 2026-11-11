/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CodeModeCell } from './cells.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';
import type { ScriptCallSummary } from './types.js';
import type { CodeModeChildDisplay } from '../tools/tools.js';

describe('CodeMode poll receipts', () => {
  it('shares child deltas with persistence, including edited args and terminal updates', () => {
    const cell = new CodeModeCell(
      {
        signal: new AbortController().signal,
        cleanups: new Set(),
        admissionGuards: new Set(),
      },
      () => {},
    );
    const call: ScriptCallSummary = {
      callId: 'read',
      name: 'Read',
      args: { file_path: 'before' },
      status: 'pending',
      readOnly: true,
      settlement: 'not_started',
    };
    const child: CodeModeChildDisplay = {
      callId: 'read',
      name: 'Read',
      args: call.args!,
      status: CoreToolCallStatus.Executing,
    };
    const first = cell.callReceipt([call], [child]);
    expect(first.calls).toHaveLength(1);
    first.commit();
    expect(cell.callReceipt([call], [child])).toMatchObject({
      calls: [],
      children: [],
    });
    const edited = { ...call, args: { file_path: 'after' } };
    const editedChild = { ...child, args: edited.args };
    const second = cell.callReceipt([edited], [editedChild]);
    expect(second.calls[0].args).toEqual({ file_path: 'after' });
    expect(second.children).toEqual([editedChild]);
    second.commit();
    const done: ScriptCallSummary = {
      ...edited,
      status: 'completed',
      settlement: 'completed',
    };
    const doneChild = {
      ...editedChild,
      status: CoreToolCallStatus.Success,
      resultDisplay: 'read',
      hostResult: { content: 'native result', is_error: false, tool_use_result: { value: 1 } },
    };
    const final = cell.callReceipt([done], [doneChild]);
    expect(final.calls).toMatchObject([
      { status: 'completed', displayStatus: CoreToolCallStatus.Success, hostResult: doneChild.hostResult },
    ]);
    final.commit();
    expect(cell.callReceipt([done], [doneChild])).toMatchObject({
      calls: [],
      children: [],
    });
    expect(first.calls[0].args).toEqual({ file_path: 'before' });
    const replaced = { ...doneChild, hostResult: { ...doneChild.hostResult, content: 'updated result' } };
    const update = cell.callReceipt([done], [replaced]);
    expect(update.calls).toHaveLength(1);
    expect(update.calls[0].hostResult?.content).toBe('updated result');
    update.commit();
    expect(cell.callReceipt([done], [replaced]).calls).toEqual([]);
  });
});
