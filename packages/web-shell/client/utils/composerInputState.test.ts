import { describe, expect, it } from 'vitest';
import {
  getComposerPlaceholderKey,
  getComposerPlaceholderState,
  shouldBlockComposerSubmit,
  shouldDisableComposerInput,
} from './composerInputState';

describe('composer input state', () => {
  it('keeps the composer editable while idle', () => {
    // Catch-up no longer participates in the composer input state: the
    // function only takes approval/preparation flags, so this unit covers
    // the idle case (catch-up behaviour is guarded by App integration tests).
    expect(
      shouldDisableComposerInput({
        pendingApproval: false,
        isPreparingPrompt: false,
      }),
    ).toBe(false);
    expect(
      getComposerPlaceholderKey({
        isPreparingPrompt: false,
        isStreaming: false,
      }),
    ).toBe('editor.placeholder');
  });

  it('keeps disabling the composer for prompt preparation', () => {
    expect(
      shouldDisableComposerInput({
        pendingApproval: false,
        isPreparingPrompt: true,
      }),
    ).toBe(true);
    expect(
      getComposerPlaceholderKey({
        isPreparingPrompt: true,
        isStreaming: false,
      }),
    ).toBe('editor.processing');
  });

  it('shows processing placeholder while streaming', () => {
    expect(
      getComposerPlaceholderKey({
        isPreparingPrompt: false,
        isStreaming: true,
      }),
    ).toBe('editor.processing');
  });

  it('exposes the semantic placeholder state independently of i18n keys', () => {
    expect(
      getComposerPlaceholderState({
        isPreparingPrompt: false,
        isStreaming: false,
      }),
    ).toBe('idle');
    expect(
      getComposerPlaceholderState({
        isPreparingPrompt: true,
        isStreaming: true,
      }),
    ).toBe('processing');
    expect(
      getComposerPlaceholderState({
        isPreparingPrompt: false,
        isStreaming: true,
      }),
    ).toBe('processing');
  });

  it('still disables editing for pending approvals', () => {
    expect(
      shouldDisableComposerInput({
        pendingApproval: true,
        isPreparingPrompt: false,
      }),
    ).toBe(true);
  });

  it('blocks submit only on error or a disconnected session without a session', () => {
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'error',
        hasSession: true,
      }),
    ).toBe(true);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'disconnected',
        hasSession: false,
      }),
    ).toBe(true);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'connecting',
        hasSession: false,
      }),
    ).toBe(false);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'connected',
        hasSession: false,
      }),
    ).toBe(false);
  });

  it('allows a disconnected session with an existing session to submit', () => {
    // The prompt is submitted over HTTP and the SSE stream is rebuilt on
    // admission, so a down stream does not block sending.
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'disconnected',
        hasSession: true,
      }),
    ).toBe(false);
  });
});
