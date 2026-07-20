import { describe, expect, it } from 'vitest';
import {
  getComposerPlaceholderKey,
  getComposerPlaceholderState,
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
        isPreparingPrompt: false,
        isStreaming: false,
      }),
    ).toBe('editor.placeholder');
    expect(
      getComposerPlaceholderKey({
        catchingUp: false,
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
        isPreparingPrompt: true,
        isStreaming: false,
      }),
    ).toBe('editor.processing');
  });

  it('shows processing placeholder while streaming', () => {
    expect(
      getComposerPlaceholderKey({
        catchingUp: false,
        isPreparingPrompt: false,
        isStreaming: true,
      }),
    ).toBe('editor.processing');
  });

  it('exposes the semantic placeholder state independently of i18n keys', () => {
    expect(
      getComposerPlaceholderState({
        catchingUp: false,
        isPreparingPrompt: false,
        isStreaming: false,
      }),
    ).toBe('idle');
    expect(
      getComposerPlaceholderState({
        catchingUp: true,
        isPreparingPrompt: true,
        isStreaming: true,
      }),
    ).toBe('loading');
    expect(
      getComposerPlaceholderState({
        catchingUp: false,
        isPreparingPrompt: true,
        isStreaming: true,
      }),
    ).toBe('processing');
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
        hasSession: true,
        restartSseOnPrompt: false,
      }),
    ).toBe(true);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'error',
        hasSession: true,
        restartSseOnPrompt: true,
      }),
    ).toBe(true);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'connecting',
        hasSession: false,
        restartSseOnPrompt: false,
      }),
    ).toBe(false);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'connected',
        hasSession: false,
        restartSseOnPrompt: false,
      }),
    ).toBe(false);
  });

  it('allows a disconnected session to submit when prompt SSE restart is enabled', () => {
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'disconnected',
        hasSession: true,
        restartSseOnPrompt: true,
      }),
    ).toBe(false);
    expect(
      shouldBlockComposerSubmit({
        connectionStatus: 'disconnected',
        hasSession: false,
        restartSseOnPrompt: true,
      }),
    ).toBe(true);
  });
});
