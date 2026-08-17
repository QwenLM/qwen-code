export function isSessionDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.endsWith('Daemon session is not connected')
  );
}
