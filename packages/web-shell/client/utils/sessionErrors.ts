export function isSessionDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.endsWith('Daemon session is not connected')
  );
}

// Transient read failures both usage panels must swallow: a disconnected
// session, a closed transport, or a plain network blip.
export function isTransientSessionReadError(error: unknown): boolean {
  return (
    isSessionDisconnectedError(error) ||
    (error instanceof Error &&
      (error.name === 'DaemonTransportClosedError' ||
        /(?:fetch failed|failed to fetch|networkerror|load failed)/i.test(
          error.message,
        )))
  );
}
