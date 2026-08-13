import type { DaemonConnectionState } from '@qwen-code/webui/daemon-react-sdk';

export function isSessionMutationBlocked(
  connection: DaemonConnectionState,
  desiredTargetPending = false,
): boolean {
  return (
    desiredTargetPending ||
    connection.sessionRecoveryRequired === true ||
    connection.sessionTransition?.phase === 'queued' ||
    connection.sessionTransition?.phase === 'preparing'
  );
}
