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

  it('projects the about item to its Status text block (G-1)', () => {
    const item = {
      type: 'about',
      systemInfo: {
        cliVersion: '0.21.12',
        osPlatform: 'darwin',
        osArch: 'arm64',
        osRelease: '24.0.0',
        nodeVersion: 'v22.0.0',
        npmVersion: '10.0.0',
        sandboxEnv: 'none',
        modelVersion: 'qwen3-max',
        selectedAuthType: 'api-key',
        ideClient: 'none',
        sessionId: 'sid-1',
        memoryUsage: '100MB',
      },
    } as unknown as HistoryItemWithoutId;
    const event = projectCommandItem(item);
    expect(event?.type).toBe('text');
    if (event?.type === 'text') {
      expect(event.delta).toContain('Status');
      expect(event.delta).toContain('Qwen Code: 0.21.12');
      expect(event.delta).toContain('Model: qwen3-max');
      expect(event.delta).toContain('Session ID: sid-1');
      expect(event.delta).toContain('Auth: API Key - api-key');
    }
  });

  it('projects tools_list items (G-2)', () => {
    const item = {
      type: 'tools_list',
      tools: [
        { name: 'read_file', displayName: 'Read File' },
        { name: 'write_file', displayName: 'Write File' },
      ],
      showDescriptions: true,
    } as unknown as HistoryItemWithoutId;
    const event = projectCommandItem(item);
    if (event?.type === 'text') {
      expect(event.delta).toContain('Available Qwen Code CLI tools:');
      expect(event.delta).toContain(' - Read File (read_file)');
    } else {
      throw new Error('expected a text event');
    }
  });

  it('projects compression items as structured compaction events (G-12)', () => {
    const item = {
      type: 'compression',
      compression: {
        isPending: false,
        originalTokenCount: 1000,
        newTokenCount: 200,
        compressionStatus: 1, // CompressionStatus.COMPRESSED
      },
    } as unknown as HistoryItemWithoutId;
    const event = projectCommandItem(item);
    if (event?.type === 'compaction') {
      expect(event.compression).toEqual({
        isPending: false,
        originalTokenCount: 1000,
        newTokenCount: 200,
        compressionStatus: 1,
      });
    } else {
      throw new Error('expected a compaction event');
    }
  });

  it('projects memory_saved and insight_progress items', () => {
    const saved = projectCommandItem({
      type: 'memory_saved',
      writtenCount: 2,
    } as unknown as HistoryItemWithoutId);
    if (saved?.type === 'text') {
      expect(saved.delta).toBe('Saved 2 memories');
    } else {
      throw new Error('expected a text event');
    }
    const progress = projectCommandItem({
      type: 'insight_progress',
      progress: { stage: 'Analyzing', progress: 100, isComplete: true },
    } as unknown as HistoryItemWithoutId);
    if (progress?.type === 'text') {
      expect(progress.delta).toBe('✓ Analyzing');
    } else {
      throw new Error('expected a text event');
    }
  });

  it('projects goal_state items onto structured goal events', () => {
    const snapshot = {
      goal: { objective: 'ship it', status: 'active', turnCount: 1 },
      activity: 'running',
    };
    const event = projectCommandItem({
      type: 'goal_state',
      snapshot,
      cause: 'create',
    } as unknown as HistoryItemWithoutId);
    if (event?.type === 'goal') {
      expect(event.snapshot).toEqual(snapshot);
      expect(event.cause).toBe('create');
    } else {
      throw new Error('expected a goal event');
    }
  });

  it('projects goal_status items onto legacy goal events', () => {
    const event = projectCommandItem({
      type: 'goal_status',
      kind: 'achieved',
      condition: 'tests green',
      iterations: 2,
      durationMs: 5000,
      lastReason: 'all passed',
    } as unknown as HistoryItemWithoutId);
    if (event?.type === 'goal-legacy') {
      expect(event).toEqual({
        type: 'goal-legacy',
        kind: 'achieved',
        condition: 'tests green',
        iterations: 2,
        durationMs: 5000,
        lastReason: 'all passed',
      });
    } else {
      throw new Error('expected a goal-legacy event');
    }
  });

  it('does not project non-transcript item kinds', () => {
    const item = { type: 'help' } as unknown as HistoryItemWithoutId;
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

  it('mounts every long-tail dialog natively (unsupported list empty)', () => {
    const nowMounted: OpenTuiDialogRequest[] = [
      { dialog: 'editor' },
      { dialog: 'auth' },
      { dialog: 'trust' },
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
    for (const request of nowMounted) {
      expect(resolveDialogRequest(request).kind).toBe('mount');
    }
  });
});

describe('resolveDispatchOutcome', () => {
  it('passes non-slash input through to the normal prompt path', () => {
    expect(resolveDispatchOutcome(false)).toEqual({ kind: 'passthrough' });
  });

  it('keeps handled outcomes and carries quit farewell messages', () => {
    expect(resolveDispatchOutcome({ kind: 'handled' })).toEqual({
      kind: 'handled',
    });
    const messages = [{ type: 'quit', duration: '1m 2s', id: 1 }] as never;
    expect(resolveDispatchOutcome({ kind: 'quit', messages })).toEqual({
      kind: 'quit',
      messages,
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
      expect(auth.resolution.kind).toBe('mount');
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

  it('routes schedule_tool to the real client-tool scheduler (G-6b)', () => {
    expect(
      resolveDispatchOutcome({
        kind: 'schedule_tool',
        toolName: 'run_shell_command',
        toolArgs: { command: 'gh auth status' },
      }),
    ).toEqual({
      kind: 'schedule_tool',
      toolName: 'run_shell_command',
      toolArgs: { command: 'gh auth status' },
    });
  });

  it('carries matchedSessions through the resume dialog request (G-5)', () => {
    const matchedSessions = [{ sessionId: 's1', prompt: 'hello' }] as never;
    expect(resolveDialogRequest({ dialog: 'resume', matchedSessions })).toEqual(
      {
        kind: 'mount',
        dialog: { dialog: 'resume', matchedSessions },
      },
    );
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

  it('projects loadHistory items onto the transcript as one commit', () => {
    const captured = createCapturedSinks();
    const resets: OpenTuiStreamEvent[][] = [];
    const sinks: BackendCommandSinks = {
      ...captured.sinks,
      resetTranscript: (events) => resets.push(events),
    };
    const host = createBackendCommandHost(sinks);
    host.loadHistory([
      { type: 'user', text: 'hello', id: 1 } as never,
      { type: 'info', text: 'world', id: 2 } as never,
    ]);
    expect(resets).toHaveLength(1);
    expect(resets[0]).toEqual([
      { type: 'user', text: 'hello' },
      { type: 'text', delta: 'world' },
      { type: 'done' },
    ]);
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

  it('tracks pendingItem for the compression re-entrancy guard (G-12)', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    expect(host.pendingItem).toBeNull();
    const pending = {
      type: 'compression',
      compression: { isPending: true },
    } as never;
    host.setPendingItem(pending);
    expect(host.pendingItem).toBe(pending);
    // The pending work is visible immediately as a structured compaction
    // event (spinner row, ink CompressionMessage parity).
    const event = captured.events.at(-1);
    if (event?.type === 'compaction') {
      expect(event.compression.isPending).toBe(true);
    } else {
      throw new Error('expected a compaction event');
    }
    host.setPendingItem(null);
    expect(host.pendingItem).toBeNull();
    host.setPendingItem(pending);
    host.clearPendingState();
    expect(host.pendingItem).toBeNull();
  });

  it('surfaces completed btw answers in the transcript (G-14)', () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    // Pending side-question: stored but not surfaced.
    host.setBtwItem({
      type: 'btw',
      btw: { question: 'q?', answer: '', isPending: true },
    } as never);
    expect(captured.events).toHaveLength(0);
    expect(host.btwItem).not.toBeNull();
    // Completed answer becomes visible.
    host.setBtwItem({
      type: 'btw',
      btw: { question: 'q?', answer: 'the answer', isPending: false },
    } as never);
    const event = captured.events.at(-1);
    if (event?.type === 'text') {
      expect(event.delta).toContain('/btw q?');
      expect(event.delta).toContain('the answer');
    } else {
      throw new Error('expected a text event');
    }
    // cancelBtw aborts and clears the side question.
    host.cancelBtw();
    expect(host.btwItem).toBeNull();
  });

  it('reports vim as faithfully unavailable (G-11b)', async () => {
    const captured = createCapturedSinks();
    const host = createBackendCommandHost(captured.sinks);
    // The renderer has no vim mode: the toggle never enables it.
    expect(await host.toggleVimEnabled()).toBe(false);
    expect(await host.toggleVimEnabled()).toBe(false);
  });

  it('routes session-name/debug/md-count/startNewSession through sinks', () => {
    const captured = createCapturedSinks();
    const sessionNames: Array<string | null> = [];
    const debugMessages: string[] = [];
    const mdCounts: number[] = [];
    const newSessions: string[] = [];
    const sinks: BackendCommandSinks = {
      ...captured.sinks,
      setSessionName: (name) => sessionNames.push(name),
      setDebugMessage: (message) => debugMessages.push(message),
      setGeminiMdFileCount: (count) => mdCounts.push(count),
      startNewSession: (sessionId) => newSessions.push(sessionId),
    };
    const host = createBackendCommandHost(sinks);
    host.setSessionName('My session');
    host.setDebugMessage('resetting');
    host.setGeminiMdFileCount(3);
    host.startNewSession?.('new-id');
    expect(sessionNames).toEqual(['My session']);
    expect(debugMessages).toEqual(['resetting']);
    expect(mdCounts).toEqual([3]);
    expect(newSessions).toEqual(['new-id']);
  });

  it('delegates confirmations to the backend sinks when provided', async () => {
    const captured = createCapturedSinks();
    const sinks: BackendCommandSinks = {
      ...captured.sinks,
      presentShellConfirmation: async (commands) => ({
        outcome: ToolConfirmationOutcome.ProceedAlways,
        approvedCommands: [...commands],
      }),
      presentActionConfirmation: async () => true,
    };
    const host = createBackendCommandHost(sinks);
    const resolution = await host.presentShellConfirmation(['git status']);
    expect(resolution.outcome).toBe(ToolConfirmationOutcome.ProceedAlways);
    expect(resolution.approvedCommands).toEqual(['git status']);
    expect(await host.presentActionConfirmation('Overwrite?')).toBe(true);
  });

  it('exposes live session stats from the sink (G-21)', () => {
    const captured = createCapturedSinks();
    const start = new Date('2026-08-14T00:00:00Z');
    const sinks: BackendCommandSinks = {
      ...captured.sinks,
      getSessionStats: () =>
        ({
          sessionId: 'live-session',
          sessionStartTime: start,
          metrics: {},
          lastPromptTokenCount: 42,
          promptCount: 2,
        }) as never,
    };
    const host = createBackendCommandHost(sinks);
    expect(host.sessionStats.sessionId).toBe('live-session');
    expect(host.sessionStats.lastPromptTokenCount).toBe(42);
    expect(host.sessionStats.sessionStartTime).toBe(start);
  });
});
