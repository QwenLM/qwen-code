/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildWorkflowSteeringNotice,
  type WorkflowContext,
  type WorkflowIntent,
} from './workflow-intent.js';
import { WorkflowModeContext } from './workflow-mode.js';

const context: WorkflowContext = {
  surface: 'pointer',
  bridgeWorkflowTool: false,
  nameOnly: false,
};
const keyword: WorkflowIntent = {
  trigger: 'ultracode',
  reminder: `<system-reminder>\n${buildWorkflowSteeringNotice('pointer', { trigger: 'ultracode' })}\n</system-reminder>`,
};

function dispatch(
  mode: WorkflowModeContext,
  intent: WorkflowIntent | null = null,
) {
  const prepared = mode.prepare(context, intent);
  prepared.onModelRequestDispatched?.();
  return prepared;
}

describe('session workflow mode notices', () => {
  it('does not invent an exit for an old session without a record', () => {
    const mode = new WorkflowModeContext();
    expect(mode.prepare(context, null)).toEqual({ reminder: undefined });
    expect(mode.prepare(context, keyword)).toEqual({
      reminder: keyword.reminder,
    });
    expect(mode.hasContext()).toBe(false);
    mode.restore(false);
    expect(dispatch(mode).reminder).toContain('Workflow mode is off');
    expect(dispatch(mode).reminder).toBeUndefined();
  });

  it('prepares without consuming and counts dispatches at turns 1, 11, 21', () => {
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    for (let index = 0; index < 4; index++) {
      expect(mode.prepare(context, null).reminder).toContain('is enabled');
    }
    const reminders: number[] = [];
    for (let turn = 1; turn <= 22; turn++) {
      const prepared = dispatch(mode);
      prepared.onModelRequestDispatched?.();
      if (prepared.reminder) reminders.push(turn);
    }
    expect(reminders).toEqual([1, 11, 21]);
  });

  it('does not reset cadence for an already recorded identical request', () => {
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    dispatch(mode);
    for (let turn = 0; turn < 9; turn++) {
      mode.setRequested(true);
      expect(dispatch(mode).reminder).toBeUndefined();
    }
    expect(dispatch(mode).reminder).toContain('remains enabled');
  });

  it('coalesces unsent changes and retires prepared callbacks', () => {
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    const old = mode.prepare(context, null);
    mode.setRequested(false);
    mode.setRequested(true);
    old.onModelRequestDispatched?.();
    expect(dispatch(mode).reminder).toContain('is enabled');
    const beforeReset = mode.prepare(context, null);
    mode.resetContext();
    beforeReset.onModelRequestDispatched?.();
    expect(dispatch(mode).reminder).toContain('is enabled');
  });

  it('has one envelope for keyword and mode, and refreshes the cadence', () => {
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    const entered = dispatch(mode, keyword).reminder!;
    expect(entered.match(/<system-reminder>/g)).toHaveLength(1);
    expect(entered).toContain('Workflow mode is enabled');
    expect(entered).not.toContain('includes the');
    for (let turn = 0; turn < 4; turn++) dispatch(mode);
    expect(dispatch(mode, keyword).reminder).toBe(keyword.reminder);
    for (let turn = 0; turn < 9; turn++) {
      expect(dispatch(mode).reminder).toBeUndefined();
    }
    expect(dispatch(mode).reminder).toContain('remains enabled');
  });

  it('keeps a valid keyword request when withdrawing persistent mode', () => {
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    dispatch(mode);
    mode.setRequested(false);
    const exit = dispatch(mode, keyword).reminder!;
    expect(exit.match(/<system-reminder>/g)).toHaveLength(1);
    expect(exit).toContain('Workflow mode is off');
    expect(exit).toContain('includes the "ultracode" keyword');
    expect(mode.hasContext()).toBe(false);
  });

  it('preserves requested on across availability loss and re-enters', () => {
    const mode = new WorkflowModeContext();
    mode.restore(true);
    dispatch(mode);
    const pause = mode.prepare(null, null);
    expect(pause.reminder).toContain('temporarily unavailable');
    pause.onModelRequestDispatched?.();
    expect(mode.getRequested()).toBe(true);
    expect(mode.prepare(null, null).reminder).toBeUndefined();
    expect(dispatch(mode).reminder).toContain('is enabled');
  });

  it('preserves the authoring surface and name-only restriction', () => {
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    const named = mode.prepare({ ...context, nameOnly: true }, null).reminder!;
    expect(named).toContain('do not write a workflow script');
    expect(named).not.toContain('load the');
    const bridged = mode.prepare(
      {
        ...context,
        surface: 'pointer-via-tool-search',
        bridgeWorkflowTool: true,
      },
      null,
    ).reminder!;
    expect(bridged).toContain('workflow-authoring');
    expect(bridged).toContain('tool_search');
  });

  it('restores a rollback snapshot without accepting pre-switch callbacks', () => {
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    dispatch(mode);
    const snapshot = mode.snapshot();
    const old = mode.prepare(context, keyword);
    mode.restore(false);
    mode.restoreSnapshot(snapshot);
    old.onModelRequestDispatched?.();
    expect(mode.snapshot()).toEqual(snapshot);
    expect(dispatch(mode).reminder).toBeUndefined();
  });
});
