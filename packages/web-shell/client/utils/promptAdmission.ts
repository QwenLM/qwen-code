import { DaemonHttpError } from '@qwen-code/sdk/daemon';

export function isDefinitelyRejectedPromptAdmission(error: unknown): boolean {
  return (
    error instanceof DaemonHttpError &&
    (error.status === 413 || error.status === 501)
  );
}
