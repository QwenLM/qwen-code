/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { Config, Logger } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type {
  ExtensionUpdateAction,
  ExtensionUpdateStatus,
} from '../state/extensions.js';
import type { ConfirmationRequest, HistoryItem } from '../types.js';
import type { OpenTuiCommandHost } from './commands-context.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import { handleBranchSession, handleResumeSession } from './session-switch.js';
import { OpenTuiAppHost, type OpenTuiAppHostDeps } from './opentui-host.js';

vi.mock('./session-switch.js', () => ({
  handleResumeSession: vi.fn(async () => {}),
  handleBranchSession: vi.fn(async () => {}),
}));

interface Harness {
  host: OpenTuiAppHost;
  onChange: ReturnType<typeof vi.fn>;
  transcriptReset: ReturnType<typeof vi.fn>;
  presentShell: ReturnType<typeof vi.fn>;
  presentAction: ReturnType<typeof vi.fn>;
  toggleVim: ReturnType<typeof vi.fn>;
  reloadCommands: ReturnType<typeof vi.fn>;
  startNewSession: ReturnType<typeof vi.fn>;
  reduceExtensionState: ReturnType<typeof vi.fn>;
}

function makeHost(): Harness {
  const onChange = vi.fn();
  const transcriptReset = vi.fn();
  const presentShell = vi.fn(async () => ({ outcome: 'proceed_once' }));
  const presentAction = vi.fn(async () => true);
  const toggleVim = vi.fn(async () => true);
  const reloadCommands = vi.fn(() => {});
  const startNewSession = vi.fn(() => {});
  const reduceExtensionState = vi.fn(() => {});

  const deps: OpenTuiAppHostDeps = {
    config: { getSessionId: () => 'sess-1' } as unknown as Config,
    settings: { merged: {} } as unknown as LoadedSettings,
    logger: null as unknown as Logger,
    transcript: { reset: transcriptReset },
    confirmations: {
      presentShell:
        presentShell as OpenTuiAppHostDeps['confirmations']['presentShell'],
      presentAction:
        presentAction as unknown as OpenTuiAppHostDeps['confirmations']['presentAction'],
    },
    onChange,
    toggleVimEnabled: toggleVim,
    reloadCommands,
    startNewSession,
    getSessionStats: () => ({ sessionId: 'sess-1' }) as SessionStatsState,
    reduceExtensionState:
      reduceExtensionState as OpenTuiAppHostDeps['reduceExtensionState'],
  };

  return {
    host: new OpenTuiAppHost(deps),
    onChange,
    transcriptReset,
    presentShell,
    presentAction,
    toggleVim,
    reloadCommands,
    startNewSession,
    reduceExtensionState,
  };
}

describe('OpenTuiAppHost — history parity with useHistory', () => {
  it('assigns incrementing ids off the base timestamp', () => {
    const { host } = makeHost();
    const id1 = host.addItem({ type: 'info', text: 'a' } as never, 1000);
    const id2 = host.addItem({ type: 'info', text: 'b' } as never, 1000);
    expect(id1).toBe(1001);
    expect(id2).toBe(1002);
    expect(host.getHistory().map((h) => h.id)).toEqual([1001, 1002]);
  });

  it('drops a consecutive duplicate user message but still returns an id', () => {
    const { host } = makeHost();
    host.addItem({ type: 'user', text: 'hi' } as never, 500);
    const dupId = host.addItem({ type: 'user', text: 'hi' } as never, 500);
    expect(host.getHistory()).toHaveLength(1);
    expect(dupId).toBe(502);
    host.addItem({ type: 'user', text: 'yo' } as never, 500);
    expect(host.getHistory()).toHaveLength(2);
  });

  it('updateItem merges by id and ignores unknown ids', () => {
    const { host } = makeHost();
    const id = host.addItem({ type: 'info', text: 'x' } as never, 1);
    host.updateItem(id, { text: 'y' } as never);
    expect(host.getHistory()[0]?.text).toBe('y');
    const before = host.getVersion();
    host.updateItem(9999, { text: 'z' } as never);
    expect(host.getVersion()).toBe(before);
  });

  it('clearItems resets history and the id counter; loadHistory replaces', () => {
    const { host } = makeHost();
    host.addItem({ type: 'info', text: 'x' } as never, 10);
    host.clearItems();
    expect(host.getHistory()).toEqual([]);
    const id = host.addItem({ type: 'info', text: 'new' } as never, 10);
    expect(id).toBe(11);
    const loaded: HistoryItem[] = [
      { id: 1, type: 'info', text: 'loaded' } as unknown as HistoryItem,
    ];
    host.loadHistory(loaded);
    expect(host.getHistory()).toBe(loaded);
  });
});

describe('OpenTuiAppHost — change notification (external store)', () => {
  it('bumps version and calls listeners + onChange on mutation', () => {
    const { host, onChange } = makeHost();
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);
    const v0 = host.getVersion();
    host.addItem({ type: 'info', text: 'x' } as never, 1);
    expect(host.getVersion()).toBe(v0 + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    host.setDebugMessage('d');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('OpenTuiAppHost — pending / btw / session state', () => {
  it('pendingItem reflects set/clear', () => {
    const { host } = makeHost();
    expect(host.pendingItem).toBeNull();
    host.setPendingItem({ type: 'info', text: 'p' } as never);
    expect(host.pendingItem?.text).toBe('p');
    host.clearPendingState();
    expect(host.pendingItem).toBeNull();
  });

  it('cancelBtw aborts the controller and clears the item', () => {
    const { host } = makeHost();
    const controller = new AbortController();
    const spy = vi.spyOn(controller, 'abort');
    host.btwAbortControllerRef.current = controller;
    host.setBtwItem({
      id: 1,
      type: 'btw',
      btw: { question: 'q', answer: 'a', isPending: false },
    } as never);
    host.cancelBtw();
    expect(spy).toHaveBeenCalled();
    expect(host.btwAbortControllerRef.current).toBeNull();
    expect(host.btwItem).toBeNull();
  });

  it('sessionName / memoryFileCount / debugMessage getters reflect setters', () => {
    const { host } = makeHost();
    host.setSessionName('branch-7');
    host.setMemoryFileCount(3);
    host.setDebugMessage('dbg');
    expect(host.sessionName).toBe('branch-7');
    expect(host.memoryFileCount).toBe(3);
    expect(host.debugMessage).toBe('dbg');
  });
});

describe('OpenTuiAppHost — shell allowlist and idle/processing', () => {
  it('addSessionShellAllowlist merges into the stable set', () => {
    const { host } = makeHost();
    const set = host.sessionShellAllowlist;
    host.addSessionShellAllowlist(['ls', 'git status']);
    host.addSessionShellAllowlist(['git status', 'cat']);
    expect(host.sessionShellAllowlist).toBe(set);
    expect([...set].sort()).toEqual(['cat', 'git status', 'ls']);
  });

  it('isIdle is false while processing or streaming', () => {
    const { host } = makeHost();
    expect(host.isIdle()).toBe(true);
    host.setIsProcessing(true);
    expect(host.isIdle()).toBe(false);
    host.setIsProcessing(false);
    host.setStreaming(true);
    expect(host.isIdle()).toBe(false);
    host.setStreaming(false);
    expect(host.isIdle()).toBe(true);
  });
});

describe('OpenTuiAppHost — forwarded shell actions', () => {
  it('routes toggle/reload/session-rotation to the injected deps', async () => {
    const h = makeHost();
    await expect(h.host.toggleVimEnabled()).resolves.toBe(true);
    expect(h.toggleVim).toHaveBeenCalled();
    await h.host.reloadCommands();
    expect(h.reloadCommands).toHaveBeenCalled();
    h.host.startNewSession('sess-2');
    expect(h.startNewSession).toHaveBeenCalledWith('sess-2');
  });

  it('delegates confirmation dialogs to the bridge', async () => {
    const h = makeHost();
    const prompt: ReactNode = 'sure?';
    await expect(
      h.host.presentShellConfirmation(['rm -rf x']),
    ).resolves.toEqual({ outcome: 'proceed_once' });
    expect(h.presentShell).toHaveBeenCalledWith(['rm -rf x']);
    await expect(h.host.presentActionConfirmation(prompt)).resolves.toBe(true);
    expect(h.presentAction).toHaveBeenCalledWith(prompt);
  });

  it('extension updates mutate through the reducer', () => {
    const h = makeHost();
    const action = { foo: 'bar' } as unknown as ExtensionUpdateAction;
    h.host.dispatchExtensionStateUpdate(action);
    expect(h.reduceExtensionState).toHaveBeenCalledWith(
      h.host.extensionsUpdateState,
      action,
    );
  });

  it('extension consent settles through the confirmation bridge', async () => {
    const h = makeHost();
    const confirmed: boolean[] = [];
    const request: ConfirmationRequest = {
      prompt: 'install this extension?',
      onConfirm: (value) => confirmed.push(value),
    };
    h.host.addConfirmUpdateExtensionRequest(request);
    await vi.waitFor(() => expect(confirmed).toEqual([true]));
    expect(h.presentAction).toHaveBeenCalledWith('install this extension?');
  });

  it('a rejected consent bridge still settles as a denial', async () => {
    const h = makeHost();
    h.presentAction.mockRejectedValueOnce(new Error('renderer blew up'));
    const confirmed: boolean[] = [];
    h.host.addConfirmUpdateExtensionRequest({
      prompt: 'install this extension?',
      onConfirm: (value) => confirmed.push(value),
    } as ConfirmationRequest);
    await vi.waitFor(() => expect(confirmed).toEqual([false]));
  });
});

describe('OpenTuiAppHost — transcript and session switch delegation', () => {
  beforeEach(() => {
    vi.mocked(handleResumeSession).mockClear();
    vi.mocked(handleBranchSession).mockClear();
  });

  it('resetTranscript forwards events to the controller', () => {
    const h = makeHost();
    const events = [{ type: 'done' }] as OpenTuiStreamEvent[];
    h.host.resetTranscript(events);
    expect(h.transcriptReset).toHaveBeenCalledWith(events);
  });

  it('handleResume / handleBranch call session-switch with the host', async () => {
    const h = makeHost();
    await h.host.handleResume('sess-9');
    expect(handleResumeSession).toHaveBeenCalledWith(h.host, 'sess-9');
    await h.host.handleBranch('my-branch');
    expect(handleBranchSession).toHaveBeenCalledWith(h.host, 'my-branch');
  });
});

describe('OpenTuiAppHost — caller steps cannot break the session swap', () => {
  it('isolates a throwing subscriber and a throwing onChange', () => {
    const h = makeHost();
    h.onChange.mockImplementation(() => {
      throw new Error('entry onChange blew up');
    });
    const unsubscribe = h.host.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    expect(() => h.host.setIsProcessing(true)).not.toThrow();
    expect(h.host.getVersion()).toBeGreaterThan(0);
    unsubscribe();
  });

  it('isolates a throwing transcript controller', () => {
    const h = makeHost();
    h.transcriptReset.mockImplementation(() => {
      throw new Error('controller blew up');
    });
    expect(() => h.host.resetTranscript([])).not.toThrow();
  });
});

describe('OpenTuiAppHost — satisfies the OpenTuiCommandHost surface', () => {
  it('exposes every host member', () => {
    const { host } = makeHost();
    const asHost: OpenTuiCommandHost = host;
    const stats: SessionStatsState = asHost.sessionStats;
    const extMap: Map<string, ExtensionUpdateStatus> =
      asHost.extensionsUpdateState;
    expect(typeof asHost.getHistory).toBe('function');
    expect(asHost.sessionShellAllowlist).toBeInstanceOf(Set);
    expect(stats).toBeDefined();
    expect(extMap).toBeInstanceOf(Map);
  });
});
