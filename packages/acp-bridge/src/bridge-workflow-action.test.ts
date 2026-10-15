/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import {
  readServeWorkflowActionInput,
  SERVE_CONTROL_EXT_METHODS,
} from './status.js';

/**
 * What an entry point reads off a request body. Values are not checked here —
 * the session runtime refuses a malformed `sourceRef` or a missing script, so
 * one refusal text serves the HTTP route and the ACP method alike.
 */
describe('readServeWorkflowActionInput', () => {
  it('reads the three start fields, keeping a null args value', () => {
    expect(
      readServeWorkflowActionInput({
        action: 'run-script',
        script: 'return 1',
        args: null,
        sourceRef: { id: 'definition-7', revision: 'rev-3' },
      }),
    ).toEqual({
      script: 'return 1',
      args: null,
      sourceRef: { id: 'definition-7', revision: 'rev-3' },
    });
  });

  it('reads nothing from a body that carries none of them', () => {
    expect(readServeWorkflowActionInput({ action: 'rerun' })).toBeUndefined();
  });

  it('forwards a malformed value rather than dropping it', () => {
    // Dropping it would turn "your sourceRef is wrong" into a run that starts
    // without one, and the host would never learn its correlation was lost.
    expect(
      readServeWorkflowActionInput({ action: 'run-saved', sourceRef: 'rev-3' }),
    ).toEqual({ sourceRef: 'rev-3' });
  });
});

/**
 * What a workflow action sends the child. The start actions carry the caller's
 * own args, `sourceRef` and script; the control actions carry none of it, so a
 * client that never sends start input keeps the request it always sent.
 */
describe('controlSessionWorkflowTask start input', () => {
  async function setup() {
    const handle = makeChannel({
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionWorkflowTaskAction
          ? { changed: true, status: 'running', taskId: 'wf_compiled1' }
          : {},
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    return { bridge, handle, session };
  }

  function lastWorkflowParams(
    handle: Awaited<ReturnType<typeof setup>>['handle'],
  ): Record<string, unknown> {
    const calls = handle.agent.extMethodCalls.filter(
      (call) =>
        call.method === SERVE_CONTROL_EXT_METHODS.sessionWorkflowTaskAction,
    );
    return calls[calls.length - 1]?.params as Record<string, unknown>;
  }

  it('forwards args, sourceRef and script to the session runtime', async () => {
    const { bridge, handle, session } = await setup();
    try {
      await expect(
        bridge.controlSessionWorkflowTask(
          session.sessionId,
          'definition-7',
          'run-script',
          { clientId: session.clientId },
          {
            script: 'return 1',
            args: { question: 'which tables grew?' },
            sourceRef: { id: 'definition-7', revision: 'rev-3' },
          },
        ),
      ).resolves.toMatchObject({ changed: true, taskId: 'wf_compiled1' });

      expect(lastWorkflowParams(handle)).toEqual({
        sessionId: session.sessionId,
        taskId: 'definition-7',
        action: 'run-script',
        script: 'return 1',
        args: { question: 'which tables grew?' },
        sourceRef: { id: 'definition-7', revision: 'rev-3' },
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('sends the same request as before when there is no start input', async () => {
    const { bridge, handle, session } = await setup();
    try {
      await bridge.controlSessionWorkflowTask(
        session.sessionId,
        'wf-1',
        'rerun',
        { clientId: session.clientId },
      );
      expect(lastWorkflowParams(handle)).toEqual({
        sessionId: session.sessionId,
        taskId: 'wf-1',
        action: 'rerun',
      });

      // An input object whose fields are all absent is no input either.
      await bridge.controlSessionWorkflowTask(
        session.sessionId,
        'wf-1',
        'rerun',
        { clientId: session.clientId },
        {},
      );
      expect(lastWorkflowParams(handle)).toEqual({
        sessionId: session.sessionId,
        taskId: 'wf-1',
        action: 'rerun',
      });
    } finally {
      await bridge.shutdown();
    }
  });

  // `null` is a JSON value a script can be handed; dropping it would turn an
  // explicit "no input" into the script's own default.
  it('keeps a null args value', async () => {
    const { bridge, handle, session } = await setup();
    try {
      await bridge.controlSessionWorkflowTask(
        session.sessionId,
        'deep-review',
        'run-saved',
        { clientId: session.clientId },
        { args: null },
      );
      expect(lastWorkflowParams(handle)).toEqual({
        sessionId: session.sessionId,
        taskId: 'deep-review',
        action: 'run-saved',
        args: null,
      });
    } finally {
      await bridge.shutdown();
    }
  });
});
