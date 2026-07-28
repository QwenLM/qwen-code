export type OverlayFailureReason =
  | 'renderer_process_gone'
  | 'renderer_unresponsive'
  | 'preload_failed'
  | 'renderer_load_failed';

export type OverlayRecoveryScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

const OVERLAY_RECOVERY_DELAY_MS = 250;
const MAX_OVERLAY_RECOVERY_ATTEMPTS = 3;

const scheduleOverlayRecovery: OverlayRecoveryScheduler = (
  callback,
  delayMs,
) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

export function isRecoverableOverlayLoadFailure(
  errorCode: number,
  isMainFrame: boolean,
): boolean {
  return isMainFrame && errorCode !== -3;
}

export class OverlayRecoveryController {
  private attempts = 0;
  private cancelRecovery: (() => void) | undefined;
  private stopped = false;

  constructor(
    private readonly onFailure: (reason: OverlayFailureReason) => void,
    private readonly onRecover: () => void,
    private readonly scheduler = scheduleOverlayRecovery,
  ) {}

  handleFailure(reason: OverlayFailureReason): void {
    if (this.stopped) return;
    this.onFailure(reason);
    if (
      this.cancelRecovery ||
      this.attempts >= MAX_OVERLAY_RECOVERY_ATTEMPTS
    ) {
      return;
    }
    this.attempts += 1;
    this.cancelRecovery = this.scheduler(() => {
      this.cancelRecovery = undefined;
      if (!this.stopped) this.onRecover();
    }, OVERLAY_RECOVERY_DELAY_MS);
  }

  markReady(): void {
    if (this.stopped) return;
    this.cancelScheduledRecovery();
  }

  stop(): void {
    this.stopped = true;
    this.cancelScheduledRecovery();
  }

  private cancelScheduledRecovery(): void {
    this.cancelRecovery?.();
    this.cancelRecovery = undefined;
  }
}
