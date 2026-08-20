type ComposerConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type ComposerPlaceholderState = 'idle' | 'processing';

export function shouldDisableComposerInput({
  pendingApproval,
  isPreparingPrompt,
}: {
  pendingApproval: boolean;
  isPreparingPrompt: boolean;
}): boolean {
  return Boolean(pendingApproval || isPreparingPrompt);
}

export function getComposerPlaceholderState({
  isPreparingPrompt,
  isStreaming,
}: {
  isPreparingPrompt: boolean;
  isStreaming: boolean;
}): ComposerPlaceholderState {
  if (isPreparingPrompt || isStreaming) return 'processing';
  return 'idle';
}

export function getComposerPlaceholderKey(input: {
  isPreparingPrompt: boolean;
  isStreaming: boolean;
}): 'editor.processing' | 'editor.placeholder' {
  switch (getComposerPlaceholderState(input)) {
    case 'processing':
      return 'editor.processing';
    case 'idle':
      return 'editor.placeholder';
  }
}

export function shouldBlockComposerSubmit({
  connectionStatus,
  hasSession,
}: {
  connectionStatus: ComposerConnectionStatus;
  hasSession: boolean;
}): boolean {
  if (connectionStatus === 'error') return true;
  return connectionStatus === 'disconnected' && !hasSession;
}
