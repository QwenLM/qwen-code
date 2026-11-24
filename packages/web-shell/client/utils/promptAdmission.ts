import {
  DaemonHttpError,
  DaemonPendingPromptLimitError,
} from '@qwen-code/sdk/daemon';

export class PromptDispatchCancelledError extends Error {
  override name = 'AbortError';
}

const DEFINITE_REJECTION_HTTP_STATUSES = new Set([
  400, 401, 403, 404, 409, 413, 429, 501,
]);

export function isDefinitelyRejectedPromptAdmission(error: unknown): boolean {
  return (
    error instanceof PromptDispatchCancelledError ||
    error instanceof DaemonPendingPromptLimitError ||
    (error instanceof DaemonHttpError &&
      DEFINITE_REJECTION_HTTP_STATUSES.has(error.status))
  );
}

export function isMcpAppPromptAdmissionRejected(error: unknown): boolean {
  return isDefinitelyRejectedPromptAdmission(error);
}

export function createPromptIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
