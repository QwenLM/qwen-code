import { describe, expect, it } from 'vitest';
import {
  getComposerPlaceholderKey,
  shouldBlockComposerSubmit,
  shouldDisableComposerInput,
} from './composerInputState';

describe('composer input state', () => {
  it('keeps the composer editable while the SSE connection is disconnected', () => {
    expect(
      shouldDisableComposerInput({
        catchingUp: false,
        pendingApproval: false,
        isPreparingPrompt: false,
      }),
    ).toBe(false);
    expect(
      getComposerPlaceholderKey({
        catchingUp: false,
        connectionStatus: 'disconnected',
        isPreparingPrompt: false,
        isStreaming: false,
      }),
    ).toBe('editor.reconnecting');
    expect(
      getComposerPlaceholderKey({
        catchingUp: false,
        connectionStatus: 'connected',
        isPreparingPrompt: false,
        isStreaming: false,
      }),
    ).toBe('editor.placeholder');
  });

  it('keeps loading state only for catch-up or prompt preparation', () => {
    expect(
      shouldDisableComposerInput({
        catchingUp: true,
        pendingApproval: false,
        isPreparingPrompt: false,
      }),
    ).toBe(true);
    expect(
      getComposerPlaceholderKey({
        catchingUp: true,
        connectionStatus: 'connected',
        isPreparingPrompt: false,
        isStreaming: false,
      }),
    ).toBe('common.loading');

    expect(
      shouldDisableComposerInput({
        catchingUp: false,
        pendingApproval: false,
        isPreparingPrompt: true,
      }),
    ).toBe(true);
    expect(
      getComposerPlaceholderKey({
        catchingUp: false,
        connectionStatus: 'connected',
        isPreparingPrompt: true,
        isStreaming: false,
      }),
    ).toBe('editor.processing');
  });

  it('shows processing placeholder while streaming', () => {
    expect(
      getComposerPlaceholderKey({
        catchingUp: false,
        connectionStatus: 'connected',
        isPreparingPrompt: false,
        isStreaming: true,
      }),
    ).toBe('editor.processing');
  });

  it('still disables editing for pending approvals', () => {
    expect(
      shouldDisableComposerInput({
        catchingUp: false,
        pendingApproval: true,
        isPreparingPrompt: false,
      }),
    ).toBe(true);
  });

  it('blocks submit only after the connection reaches a failed state', () => {
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'disconnected',
      }),
    ).toBe(true);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'error',
      }),
    ).toBe(true);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'connecting',
      }),
    ).toBe(false);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'connected',
      }),
    ).toBe(false);
  });
});
