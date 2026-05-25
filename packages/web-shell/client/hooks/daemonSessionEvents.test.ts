import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  handleSilentDaemonEvent,
  hasAssistantDelta,
} from './daemonSessionEvents';

describe('hasAssistantDelta', () => {
  it('returns true when assistant.text.delta is present', () => {
    expect(hasAssistantDelta([{ type: 'assistant.text.delta' }])).toBe(true);
  });

  it('returns false when no assistant delta', () => {
    expect(hasAssistantDelta([{ type: 'session_update' }])).toBe(false);
  });
});

describe('handleSilentDaemonEvent', () => {
  it('updates tokenCount from session_update usage', () => {
    const setConnection = vi.fn();
    const event = {
      type: 'session_update',
      data: {
        update: {
          _meta: { usage: { inputTokens: 500 } },
        },
      },
    };

    handleSilentDaemonEvent(event as DaemonEvent, setConnection);
    expect(setConnection).toHaveBeenCalled();
    const updater = setConnection.mock.calls[0][0];
    const result = updater({ status: 'connected', tokenCount: 100 });
    expect(result.tokenCount).toBe(500);
  });

  it('updates currentModel on model_switched', () => {
    const setConnection = vi.fn();
    const event = {
      type: 'model_switched',
      data: { modelId: 'claude-opus-4-6' },
    };

    const result = handleSilentDaemonEvent(event as DaemonEvent, setConnection);
    expect(result).toBe(true);
    expect(setConnection).toHaveBeenCalled();
    const updater = setConnection.mock.calls[0][0];
    expect(updater({ currentModel: 'old' }).currentModel).toBe(
      'claude-opus-4-6',
    );
  });

  it('updates currentMode on approval_mode_changed', () => {
    const setConnection = vi.fn();
    const event = {
      type: 'approval_mode_changed',
      data: { next: 'auto-edit' },
    };

    const result = handleSilentDaemonEvent(event as DaemonEvent, setConnection);
    expect(result).toBe(true);
    const updater = setConnection.mock.calls[0][0];
    expect(updater({ currentMode: 'default' }).currentMode).toBe('auto-edit');
  });

  it('returns true for silently consumed events', () => {
    const setConnection = vi.fn();
    for (const type of [
      'session_metadata_updated',
      'memory_changed',
      'agent_changed',
      'tool_toggled',
      'mcp_server_restarted',
      'mcp_server_restart_refused',
    ]) {
      expect(
        handleSilentDaemonEvent({ type } as DaemonEvent, setConnection),
      ).toBe(true);
    }
  });

  it('returns false for unhandled events', () => {
    const setConnection = vi.fn();
    expect(
      handleSilentDaemonEvent(
        { type: 'assistant.text.delta' } as DaemonEvent,
        setConnection,
      ),
    ).toBe(false);
  });
});
