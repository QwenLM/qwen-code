/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI CommandContext builder against the ink processor's
 * `commandContext` useMemo (ui/hooks/slashCommandProcessor.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import {
  createOpenTuiCommandContext,
  type OpenTuiCommandHost,
} from './commands-context.js';

// clear() must NOT call clearScreen(): the OpenTUI renderer owns the screen
// (audit 01 G-20); the mock records any accidental raw-ANSI regression.
// The vi.mock factory runs at module load time, so the mock must be hoisted.
const clearScreenMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/stdioHelpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/stdioHelpers.js')>();
  return { ...actual, clearScreen: clearScreenMock };
});

function createFakeHost(): OpenTuiCommandHost & {
  calls: string[];
  sessionNames: Array<string | null>;
} {
  const calls: string[] = [];
  const sessionNames: Array<string | null> = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    sessionNames,
    getHistory: () => [{ id: 1, type: 'info', text: 'existing' }] as never,
    addItem: record('addItem') as never,
    updateItem: record('updateItem') as never,
    clearItems: record('clearItems'),
    loadHistory: record('loadHistory') as never,
    refreshStatic: record('refreshStatic'),
    clearPendingState: record('clearPendingState'),
    cancelBtw: record('cancelBtw'),
    btwItem: null,
    setBtwItem: record('setBtwItem') as never,
    btwAbortControllerRef: { current: null },
    pendingItem: null,
    setPendingItem: record('setPendingItem') as never,
    setDebugMessage: record('setDebugMessage') as never,
    toggleVimEnabled: async () => {
      calls.push('toggleVimEnabled');
      return true;
    },
    setGeminiMdFileCount: record('setGeminiMdFileCount') as never,
    reloadCommands: record('reloadCommands'),
    setSessionName: (name: string | null) => {
      calls.push('setSessionName');
      sessionNames.push(name);
    },
    isIdle: () => true,
    extensionsUpdateState: new Map(),
    dispatchExtensionStateUpdate: record(
      'dispatchExtensionStateUpdate',
    ) as never,
    addConfirmUpdateExtensionRequest: record(
      'addConfirmUpdateExtensionRequest',
    ) as never,
    sessionStats: {
      sessionId: 'sess-1',
    } as unknown as SessionStatsState,
    sessionShellAllowlist: new Set(['ls']),
    addSessionShellAllowlist: record('addSessionShellAllowlist') as never,
    setIsProcessing: record('setIsProcessing') as never,
    presentShellConfirmation: async () => ({
      outcome: ToolConfirmationOutcome.Cancel,
    }),
    presentActionConfirmation: async () => false,
    handleResume: record('handleResume') as never,
    handleBranch: record('handleBranch') as never,
  };
}

describe('createOpenTuiCommandContext (ink commandContext parity)', () => {
  const services = {
    config: null,
    settings: {} as LoadedSettings,
    logger: null,
  };

  it('clear() runs the ink sequence minus clearScreen, ending with setSessionName(null)', () => {
    const host = createFakeHost();
    const context = createOpenTuiCommandContext(host, services);
    context.ui.clear();
    // Ink: cancelBtw → clearPendingState → clearItems → clearScreen →
    // refreshStatic → setSessionName(null). The clearScreen step is skipped:
    // clearItems already clears the renderer-level transcript.
    expect(host.calls).toEqual([
      'cancelBtw',
      'clearPendingState',
      'clearItems',
      'refreshStatic',
      'setSessionName',
    ]);
    expect(clearScreenMock).not.toHaveBeenCalled();
    // Ink clears the session name as the final step.
    expect(host.sessionNames).toEqual([null]);
  });

  it('exposes a live history getter backed by the host', () => {
    const host = createFakeHost();
    const context = createOpenTuiCommandContext(host, services);
    expect(context.ui.history).toEqual([
      { id: 1, type: 'info', text: 'existing' },
    ]);
  });

  it('isIdleRef reflects the host idle state live', () => {
    const host = createFakeHost();
    let idle = true;
    host.isIdle = () => idle;
    const context = createOpenTuiCommandContext(host, services);
    expect(context.ui.isIdleRef.current).toBe(true);
    idle = false;
    expect(context.ui.isIdleRef.current).toBe(false);
  });

  it('falls back to a fresh ExtensionRefreshState like the ink useRef', () => {
    const host = createFakeHost();
    const context = createOpenTuiCommandContext(host, services);
    expect(context.services.extensionRefreshState).toBeInstanceOf(
      ExtensionRefreshState,
    );
    const provided = new ExtensionRefreshState();
    const withProvided = createOpenTuiCommandContext(host, {
      ...services,
      extensionRefreshState: provided,
    });
    expect(withProvided.services.extensionRefreshState).toBe(provided);
  });

  it('wires services and session state like the ink context', () => {
    const host = createFakeHost();
    const context = createOpenTuiCommandContext(host, services);
    expect(context.executionMode).toBe('interactive');
    expect(context.services.config).toBeNull();
    expect(context.services.settings).toBe(services.settings);
    expect(context.services.logger).toBeNull();
    expect(context.session.stats.sessionId).toBe('sess-1');
    expect(context.session.sessionShellAllowlist).toEqual(new Set(['ls']));
  });

  it('routes ui primitives through the host', async () => {
    const host = createFakeHost();
    const context = createOpenTuiCommandContext(host, services);
    expect(await context.ui.toggleVimEnabled()).toBe(true);
    context.ui.setDebugMessage('dbg');
    context.ui.refreshStatic();
    expect(host.calls).toContain('toggleVimEnabled');
    expect(host.calls).toContain('setDebugMessage');
    expect(host.calls).toContain('refreshStatic');
  });
});
