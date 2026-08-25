export function isSessionDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'DaemonTransportClosedError' ||
      /(?:fetch failed|failed to fetch)/i.test(error.message) ||
      error.message.endsWith('Daemon session is not connected'))
  );
}
