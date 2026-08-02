import { DaemonHttpError } from '@qwen-code/sdk/daemon';

export function isDefinitelyRejectedPromptAdmission(error: unknown): boolean {
  return (
    error instanceof DaemonHttpError &&
    ((error.status >= 400 && error.status < 500) || error.status === 501)
  );
}
