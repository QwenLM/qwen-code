export function isSessionDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.endsWith('Daemon session is not connected')
  );
}

const PLANNED_RECONNECT_ERROR = /^Reconnecting in \d+ms$/u;

export function isPlannedReconnectError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  return message !== undefined && PLANNED_RECONNECT_ERROR.test(message);
}

export function shouldSurfaceDaemonConnectionError(connection: {
  status: string;
  error?: string;
}): connection is { status: string; error: string } {
  return (
    typeof connection.error === 'string' &&
    connection.error.length > 0 &&
    connection.status !== 'connecting' &&
    !isPlannedReconnectError(connection.error)
  );
}
