/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend-facing integration tests for the command bridge (R2): projection of
 * dispatcher history items onto the neutral stream, dispatch-outcome
 * resolution, dialog classification, and the concrete command host.
 */

import { describe, it, expect } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import { type HistoryItemWithoutId } from '../types.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { OpenTuiDialogRequest } from './commands-registry.js';
import {
  createBackendCommandHost,
  projectCommandItem,
  resolveDialogRequest,
  resolveDispatchOutcome,
  type BackendCommandSinks,
} from './command-bridge.js';

describe('projectCommandItem', () => {
  it('projects user invocations onto user events', () => {
    expect(projectCommandItem({ type: 'user', text: '/help' })).toEqual({
      type: 'user',
      text: '/help',
    });
  });

  it('projects info/success/warning/error onto text events', () => {
    for (const type of ['info', 'success', 'warning', 'error'] as const) {
      expect(projectCommandItem({ type, text: `m-${type}` })).toEqual({
        type: 'text',
        delta: `m-${type}`,
      });
    }
  });

  it('does not project non-transcript item kinds', () => {
    const item = {
      type: 'about',
      systemInfo: {},
    } as unknown as HistoryItemWithoutId;
    expect(projectCommandItem(item)).toBeNull();
  });
});

describe('resolveDialogRequest', () => {
  it('mounts the ported dialog family', () => {
    expect(resolveDialogRequest({ dialog: 'help' })).toEqual({
      kind: 'mount',
      dialog: { dialog: 'help' },
    });
    expect(resolveDialogRequest({ dialog: 'theme' })).toEqual({
      kind: 'mount',
      dialog: { dialog: 'theme' },
    });
    expect(resolveDialogRequest({ dialog: 'settings' })).toEqual({
      kind: 'mount',
      dialog: { dialog: 'settings' },
    });
    expect(resolveDialogRequest({ dialog: 'permissions' })).toEqual({
      kind: 'mount',
      dialog: { dialog: 'permissions' },
    });
    expect(resolveDialogRequest({ dialog: 'extensions_manage' })).toEqual({
      kind: 'mount',
      dialog: { dialog: 'extensions_manage' },
    });
    expect(resolveDialogRequest({ dialog: 'mcp' })).toEqual({
      kind: 'mount',
      dialog: { dialog: 'mcp' },
    });
  });

  it('mounts the model dialog with its mode and persist scope', () => {
    expect(
      resolveDialogRequest({
        dialog: 'model',
        mode: 'fast',
        persistScope: 'workspace',
      }),
    ).toEqual({
      kind: 'mount',
      dialog: { dialog: 'model', mode: 'fast', persistScope: 'workspace' },
    });
    expect(resolveDialogRequest({ dialog: 'model', mode: 'primary' })).toEqual({
      kind: 'mount',
      dialog: { dialog: 'model', mode: 'primary' },
    });
  });

  it('represents unsupported dialog kinds explicitly', () => {
    const unsupported: OpenTuiDialogRequest[] = [
      { dialog: 'editor' },
      { dialog: 'statusline' },
      { dialog: 'memory' },
      { dialog: 'auth' },
      { dialog: 'trust' },
      { dialog: 'approval-mode' },
      { dialog: 'effort' },
      { dialog: 'delete' },
      { dialog: 'resume' },
      { dialog: 'branch' },
      { dialog: 'hooks' },
      { dialog: 'rewind' },
      { dialog: 'diff' },
      { dialog: 'arena', mode: 'start' },
      { dialog: 'subagent_create' },
      { dialog: 'subagent_list' },
    ];
    expect(unsupported.length).toBeGreaterThan(0);
    for (const request of unsupported) {
      const resolution = resolveDialogRequest(request);
      expect(resolution.kind).toBe('unsupported');
      if (resolution.kind === 'unsupported') {
        expect(resolution.message).toContain(request.dialog);
        expect(resolution.message).toContain('not yet available');
      }
    }
  });
});

describe('resolveDispatchOutcome', () => {
  it('passes non-slash input through to the normal prompt path', () => {
    expect(resolveDispatchOutcome(false)).toEqual({ kind: 'passthrough' });
  });

  it('keeps handled/quit outcomes as-is', () => {
    expect(resolveDispatchOutcome({ kind: 'handled' })).toEqual({
      kind: 'handled',
    });
    expect(resolveDispatchOutcome({ kind: 'quit', messages: [] })).toEqual({
      kind: 'quit',
    });
  });

  it('routes open_dialog through dialog classification', () => {
    expect(
      resolveDispatchOutcome({
        kind: 'open_dialog',
        request: { dialog: 'theme' },
      }),
    ).toEqual({
      kind: 'dialog',
      resolution: { kind: 'mount', dialog: { dialog: 'theme' } },
    });
    const auth = resolveDispatchOutcome({
      kind: 'open_dialog',
      request: { dialog: 'auth' },
    });
    expect(auth.kind).toBe('dialog');
    if (auth.kind === 'dialog') {
      expect(auth.resolution.kind).toBe('unsupported');
    }
  });

  it('carries text-part submit_prompt payloads to the live client unchanged', () => {
    const content = [{ text: 'plan ' }, { text: 'this' }];
    expect(resolveDispatchOutcome({ kind: 'submit_prompt', content })).toEqual({
      kind: 'submit',
      content,
    });
  });

  it('preserves multimodal parts instead of stringifying them', () => {
    const content = [
      { text: 'describe this: ' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ];
    const action = resolveDispatchOutcome({ kind: 'submit_prompt', content });
    expect(action).toEqual({ kind: 'submit', content });
    if (action.kind === 'submit') {
      expect(action.content).toBe(content);
    }
  });

  it('carries the onComplete callback into the submit action', async () => {
    let completed = false;
    const onComplete = async () => {
      completed = true;
    };
    const action = resolveDispatchOutcome({
      kind: 'submit_prompt',
      content: 'go',
      onComplete,
    });
    expect(action.kind).toBe('submit');
    if (action.kind === 'submit') {
      expect(action.onComplete).toBe(onComplete);
      await action.onComplete?.();
      expect(completed).toBe(true);
    }
  });

  it('carries the modelOverride into the submit action', () => {
    const action = resolveDispatchOutcome({
      kind: 'submit_prompt',
      content: 'go',
      modelOverride: 'fast-model-x',
    });
    expect(action).toEqual({
      kind: 'submit',
      content: 'go',
      modelOverride: 'fast-model-x',
    });
  });

  it('keeps onComplete and modelOverride together on stacked payloads', () => {
    const onComplete = async () => {};
    const action = resolveDispatchOutcome({
      kind: 'submit_prompt',
      content: [{ text: 'a' }, { text: 'b' }],
      onComplete,
      modelOverride: 'm-x',
    });
    expect(action).toEqual({
      kind: 'submit',
      content: [{ text: 'a' }, { text: 'b' }],
      onComplete,
      modelOverride: 'm-x',
    });
  });

  it('reports schedule_tool as an explicit unsupported capability', () => {
    expect(
      resolveDispatchOutcome({
        kind: 'schedule_tool',
        toolName: 'restore_session',
        toolArgs: {},
      }),
    ).toEqual({
      kind: 'unsupported',
      message: `Tool scheduling for 'restore_session' is not yet available in the OpenTUI renderer.`,
    });
  });
});

interface CapturedSinks {
  sinks: BackendCommandSinks;
  events: OpenTuiStreamEvent[];
  clears: number;
  idle: boolean;
  processing: boolean[];
  reloads: number;
}

function createCapturedSinks(): CapturedSinks {
  const captured: CapturedSinks = {
    events: [],
    clears: 0,
    idle: true,
    processing: [],
    reloads: 0,
    sinks: {} as BackendCommandSinks,
  };
  captured.sinks = {
    applyEvent: (event) => captured.events.push(event),
    clearItems: () => {
      captured.clears += 1;
    },
    isIdle: () => captured.idle,
    setProcessing: (processing) => captured.processing.push(processing),
    reloadCommands: () => {
      captured.reloads += 1;
    },
  };
  return captured;
}

describe('createBackendCommandHost', () => {
  it('projects added command items onto the event sink and keeps history', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    const id1 = host.addItem({ type: 'user', text: '/help' }, 1);
    const id2 = host.addItem({ type: 'info', text: 'answer' }, 2);
    expect([id1, id2]).toEqual([0, 1]);
    expect(captured.events).toEqual([
      { type: 'user', text: '/help' },
      { type: 'text', delta: 'answer' },
    ]);
    expect(host.getHistory()).toHaveLength(2);
  });

  it('clearItems empties both histories', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    host.addItem({ type: 'info', text: 'x' }, 1);
    host.clearItems();
    expect(host.getHistory()).toHaveLength(0);
    expect(captured.clears).toBe(1);
  });

  it('loadHistory replaces the command history', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    host.addItem({ type: 'info', text: 'x' }, 1);
    host.loadHistory([{ type: 'info', text: 'y', id: 9 }] as never);
    expect(host.getHistory()).toHaveLength(1);
    expect(host.getHistory()[0]).toMatchObject({ text: 'y', id: 9 });
  });

  it('isIdle and setIsProcessing route through the sinks', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    expect(host.isIdle()).toBe(true);
    captured.idle = false;
    expect(host.isIdle()).toBe(false);
    host.setIsProcessing(true);
    host.setIsProcessing(false);
    expect(captured.processing).toEqual([true, false]);
  });

  it('reloadCommands reaches the sink', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    host.reloadCommands();
    expect(captured.reloads).toBe(1);
  });

  it('merges the session shell allowlist', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    host.addSessionShellAllowlist(['git status', 'ls']);
    expect([...host.sessionShellAllowlist]).toEqual(['git status', 'ls']);
  });

  it('cancels shell confirmations with an explicit message', async () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    const resolution = await host.presentShellConfirmation(['rm -rf /']);
    expect(resolution.outcome).toBe(ToolConfirmationOutcome.Cancel);
    const event = captured.events.at(-1);
    expect(event).toMatchObject({ type: 'text' });
    if (event?.type === 'text') {
      expect(event.delta).toContain('rm -rf /');
      expect(event.delta).toContain('not yet available');
    }
  });

  it('rejects action confirmations with an explicit message', async () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    const confirmed = await host.presentActionConfirmation('Overwrite file?');
    expect(confirmed).toBe(false);
    const event = captured.events.at(-1);
    if (event?.type === 'text') {
      expect(event.delta).toContain('Overwrite file?');
      expect(event.delta).toContain('not yet available');
    } else {
      throw new Error('expected a text event');
    }
  });

  it('reports resume and branch as explicit unsupported capabilities', async () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    await host.handleResume('session-1');
    await host.handleBranch('wip');
    const deltas = captured.events
      .filter(
        (event): event is Extract<OpenTuiStreamEvent, { type: 'text' }> =>
          event.type === 'text',
      )
      .map((event) => event.delta);
    expect(deltas[0]).toContain('session-1');
    expect(deltas[0]).toContain('not yet available');
    expect(deltas[1]).toContain('not yet available');
  });

  it('updateItem patches an existing history item', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    const id = host.addItem(
      { type: 'user', text: '/skill', sentToModel: false } as never,
      1,
    );
    host.updateItem(id, { sentToModel: true });
    expect(host.getHistory()[0]).toMatchObject({ sentToModel: true });
  });
});
