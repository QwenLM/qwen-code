type ComposerConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

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

export function getComposerPlaceholderKey({
  catchingUp,
  connectionStatus,
  isPreparingPrompt,
  isStreaming,
}: {
  catchingUp: boolean;
  connectionStatus: ComposerConnectionStatus;
  isPreparingPrompt: boolean;
  isStreaming: boolean;
}):
  | 'common.loading'
  | 'editor.processing'
  | 'editor.reconnecting'
  | 'editor.placeholder' {
  if (catchingUp) return 'common.loading';
  if (isPreparingPrompt || isStreaming) return 'editor.processing';
  if (connectionStatus === 'disconnected' || connectionStatus === 'error') {
    return 'editor.reconnecting';
  }
  return 'editor.placeholder';
}

export function shouldBlockComposerSubmit({
  connectionStatus,
}: {
  connectionStatus: ComposerConnectionStatus;
}): boolean {
  return connectionStatus === 'disconnected' || connectionStatus === 'error';
}
