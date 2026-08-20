export function extractErrorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const body = (error as { body?: unknown }).body;
    if (body && typeof body === 'object') {
      const data = (body as { data?: unknown }).data;
      if (data && typeof data === 'object') {
        const details = (data as { details?: unknown }).details;
        if (typeof details === 'string' && details) return details;
      }
      const bodyError = (body as { error?: unknown }).error;
      if (typeof bodyError === 'string' && bodyError) return bodyError;
    }
    if (error instanceof Error && error.message) return error.message;
  }
  return String(error);
}
