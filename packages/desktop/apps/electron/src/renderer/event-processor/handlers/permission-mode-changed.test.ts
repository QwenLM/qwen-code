import { describe, expect, it } from 'bun:test';
import { handlePermissionModeChanged } from './session';
import type { SessionState, PermissionModeChangedEvent } from '../types';

describe('handlePermissionModeChanged', () => {
  it('propagates transition metadata in effect payload', () => {
    const state = {
      session: { id: 's1' },
      streaming: null,
    } as unknown as SessionState;

    const event: PermissionModeChangedEvent = {
      type: 'permission_mode_changed',
      sessionId: 's1',
      permissionMode: 'allow-all',
      previousPermissionMode: 'safe',
      transitionDisplay: 'Plan mode -> YOLO',
      modeVersion: 12,
      changedAt: '2026-03-02T10:00:00.000Z',
      changedBy: 'user',
    };

    const result = handlePermissionModeChanged(state, event);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toEqual({
      type: 'permission_mode_changed',
      sessionId: 's1',
      permissionMode: 'allow-all',
      previousPermissionMode: 'safe',
      transitionDisplay: 'Plan mode -> YOLO',
      modeVersion: 12,
      changedAt: '2026-03-02T10:00:00.000Z',
      changedBy: 'user',
    });
  });
});
