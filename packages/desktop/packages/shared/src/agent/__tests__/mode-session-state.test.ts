import { describe, it, expect } from 'bun:test';
import {
  cleanupModeState,
  formatSessionState,
  getPermissionModeDiagnostics,
  hydratePreviousPermissionMode,
  initializeModeState,
  setPermissionMode,
} from '../mode-manager.ts';

describe('mode transition session_state context', () => {
  it('includes explicit transition metadata after a mode change', () => {
    const sessionId = `mode-transition-${Date.now()}`;

    initializeModeState(sessionId, 'safe');
    setPermissionMode(sessionId, 'allow-all', {
      changedBy: 'user',
      changedAt: '2026-03-02T08:00:00.000Z',
    });

    const diagnostics = getPermissionModeDiagnostics(sessionId);
    expect(diagnostics.permissionMode).toBe('allow-all');
    expect(diagnostics.previousPermissionMode).toBe('safe');
    expect(diagnostics.transitionDisplay).toBe('Plan mode -> YOLO');

    const stateBlock = formatSessionState(sessionId, {
      plansFolderPath: '/tmp/plans',
      dataFolderPath: '/tmp/data',
    });

    expect(stateBlock).toContain('permissionMode: execute');
    expect(stateBlock).toContain('modeTransition: Plan mode -> YOLO');
    expect(stateBlock).toContain('modeChangedBy: user');
    expect(stateBlock).toContain('modeChangedAt: 2026-03-02T08:00:00.000Z');
    expect(stateBlock).toContain('modeVersion: 2');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by user at 2026-03-02T08:00:00.000Z (Plan mode -> YOLO, modeVersion=2)');
    expect(stateBlock).toContain('modeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.');

    cleanupModeState(sessionId);
  });

  it('omits modeTransition when no previous mode exists', () => {
    const sessionId = `mode-no-transition-${Date.now()}`;

    const stateBlock = formatSessionState(sessionId, {
      plansFolderPath: '/tmp/plans',
    });

    expect(stateBlock).toContain('permissionMode: ask');
    expect(stateBlock).not.toContain('modeTransition:');
    expect(stateBlock).toContain('modeVersion: 0');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });

  it('does not emit a synthetic modeTransition on initial restore', () => {
    const sessionId = `mode-restore-${Date.now()}`;

    initializeModeState(sessionId, 'safe');

    const diagnostics = getPermissionModeDiagnostics(sessionId);
    expect(diagnostics.permissionMode).toBe('safe');
    expect(diagnostics.transitionDisplay).toBeUndefined();

    const stateBlock = formatSessionState(sessionId);
    expect(stateBlock).toContain('permissionMode: explore');
    expect(stateBlock).not.toContain('modeTransition:');
    expect(stateBlock).toContain('modeChangedBy: restore');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by restore');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });

  it('restores modeTransition after rehydrating persisted previous mode', () => {
    const sessionId = `mode-rehydrate-${Date.now()}`;

    // Simulate restored current mode after app restart.
    setPermissionMode(sessionId, 'allow-all', { changedBy: 'restore' });
    hydratePreviousPermissionMode(sessionId, 'safe');

    const diagnostics = getPermissionModeDiagnostics(sessionId);
    expect(diagnostics.permissionMode).toBe('allow-all');
    expect(diagnostics.previousPermissionMode).toBe('safe');
    expect(diagnostics.transitionDisplay).toBe('Plan mode -> YOLO');

    const stateBlock = formatSessionState(sessionId);
    expect(stateBlock).toContain('permissionMode: execute');
    expect(stateBlock).toContain('modeTransition: Plan mode -> YOLO');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by restore');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });

  it('emits modeChangeUserSignal once when consume option is enabled', () => {
    const sessionId = `mode-consume-once-${Date.now()}`;

    initializeModeState(sessionId, 'safe');
    setPermissionMode(sessionId, 'allow-all', {
      changedBy: 'user',
      changedAt: '2026-03-02T09:00:00.000Z',
    });

    const first = formatSessionState(sessionId, {
      consumeModeChangeUserSignal: true,
    });
    expect(first).toContain('modeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.');

    const second = formatSessionState(sessionId, {
      consumeModeChangeUserSignal: true,
    });
    expect(second).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });
});
