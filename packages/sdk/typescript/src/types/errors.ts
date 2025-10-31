/**
 * Error types for SDK
 */

/**
 * Error thrown when an operation is aborted via AbortSignal
 */
export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
    Object.setPrototypeOf(this, AbortError.prototype);
  }
}

/**
 * Check if an error is an AbortError
 */
export function isAbortError(error: unknown): error is AbortError {
  return (
    error instanceof AbortError ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'AbortError')
  );
}
