import {
  DaemonHttpError,
  DaemonPendingPromptLimitError,
} from '@qwen-code/sdk/daemon';

export class PromptDispatchCancelledError extends Error {
  override name = 'AbortError';
}

export function isMcpAppPromptAdmissionRejected(error: unknown): boolean {
  return (
    error instanceof PromptDispatchCancelledError ||
    error instanceof DaemonPendingPromptLimitError ||
    (error instanceof DaemonHttpError &&
      [400, 401, 403, 404, 409, 413, 429, 501].includes(error.status))
  );
}

export function isDefinitelyRejectedPromptAdmission(error: unknown): boolean {
  return (
    error instanceof DaemonHttpError &&
    (error.status === 413 || error.status === 501)
  );
}
