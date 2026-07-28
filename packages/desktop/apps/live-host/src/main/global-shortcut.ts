export type GlobalShortcutBackend = {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
};

export type GlobalShortcutState = {
  accelerator?: string;
  healthy: boolean;
};

export type ShortcutRetryScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

const SHORTCUT_RETRY_DELAY_MS = 5_000;

const scheduleShortcutRetry: ShortcutRetryScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

export class LiveGlobalShortcut {
  private accelerator: string | undefined;
  private desiredAccelerator: string | undefined;
  private healthy = false;
  private cancelRetry: (() => void) | undefined;

  constructor(
    private readonly backend: GlobalShortcutBackend,
    private readonly onToggle: () => void,
    private readonly onState: (state: GlobalShortcutState) => void,
    private readonly retryScheduler = scheduleShortcutRetry,
  ) {}

  replace(accelerator: string): void {
    const unchanged = accelerator === this.desiredAccelerator;
    this.desiredAccelerator = accelerator;
    if (
      unchanged &&
      ((accelerator === this.accelerator && this.healthy) || this.cancelRetry)
    ) {
      return;
    }
    this.cancelScheduledRetry();
    this.attemptRegistration();
  }

  stop(): void {
    this.desiredAccelerator = undefined;
    this.cancelScheduledRetry();
    const wasRegistered = Boolean(this.accelerator) || this.healthy;
    this.unregisterCurrent();
    if (wasRegistered) this.publish({ healthy: false });
  }

  private attemptRegistration(): void {
    const accelerator = this.desiredAccelerator;
    if (!accelerator || (this.healthy && accelerator === this.accelerator)) {
      return;
    }
    this.unregisterCurrent();

    let registered = false;
    try {
      registered = this.backend.register(accelerator, this.onToggle);
    } catch {
      registered = false;
    }
    this.accelerator = registered ? accelerator : undefined;
    this.publish({ accelerator, healthy: registered });
    if (!registered) this.scheduleRetry();
  }

  private unregisterCurrent(): void {
    if (this.accelerator) {
      try {
        this.backend.unregister(this.accelerator);
      } catch {
        // A failed unregister must not leave the shortcut marked healthy.
      }
    }
    this.accelerator = undefined;
    this.healthy = false;
  }

  private scheduleRetry(): void {
    if (this.cancelRetry || this.healthy || !this.desiredAccelerator) return;
    this.cancelRetry = this.retryScheduler(() => {
      this.cancelRetry = undefined;
      this.attemptRegistration();
    }, SHORTCUT_RETRY_DELAY_MS);
  }

  private cancelScheduledRetry(): void {
    this.cancelRetry?.();
    this.cancelRetry = undefined;
  }

  private publish(state: GlobalShortcutState): void {
    this.healthy = state.healthy;
    this.onState(state);
  }
}
