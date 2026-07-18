type ComposerConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type ComposerPlaceholderState = 'idle' | 'loading' | 'processing';

export function shouldDisableComposerInput({
  catchingUp,
  pendingApproval,
  isPreparingPrompt,
}: {
  catchingUp: boolean;
  pendingApproval: boolean;
  isPreparingPrompt: boolean;
}): boolean {
  return Boolean(catchingUp || pendingApproval || isPreparingPrompt);
}

export function getComposerPlaceholderState({
  catchingUp,
  isPreparingPrompt,
  isStreaming,
}: {
  catchingUp: boolean;
  isPreparingPrompt: boolean;
  isStreaming: boolean;
}): ComposerPlaceholderState {
  if (catchingUp) return 'loading';
  if (isPreparingPrompt || isStreaming) return 'processing';
  return 'idle';
}

export function getComposerPlaceholderKey(input: {
  catchingUp: boolean;
  isPreparingPrompt: boolean;
  isStreaming: boolean;
}): 'common.loading' | 'editor.processing' | 'editor.placeholder' {
  switch (getComposerPlaceholderState(input)) {
    case 'loading':
      return 'common.loading';
    case 'processing':
      return 'editor.processing';
    case 'idle':
      return 'editor.placeholder';
  }
}

export function shouldBlockComposerSubmit({
  connectionStatus,
  hasSession,
  restartSseOnPrompt,
}: {
  connectionStatus: ComposerConnectionStatus;
  hasSession: boolean;
  restartSseOnPrompt: boolean;
}): boolean {
  if (connectionStatus === 'error') return true;
  return (
    connectionStatus === 'disconnected' && (!restartSseOnPrompt || !hasSession)
  );
}
