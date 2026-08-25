export type GlobalShortcutBackend = {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
};

export type GlobalShortcutState = {
  accelerator?: string;
  healthy: boolean;
  error?: string;
};

export class LiveGlobalShortcut {
  private accelerator: string | undefined;
  private healthy = false;

  constructor(
    private readonly backend: GlobalShortcutBackend,
    private readonly onToggle: () => void,
    private readonly onState: (state: GlobalShortcutState) => void,
  ) {}

  replace(accelerator: string): GlobalShortcutState {
    if (this.healthy && accelerator === (this.accelerator ?? '')) {
      return { accelerator, healthy: true };
    }
    if (accelerator === '') {
      this.unregisterCurrent();
      return this.publish({ accelerator, healthy: true });
    }
    const previous = this.accelerator;
    const previousHealthy = this.healthy;
    let registered = false;
    let invalid = false;
    try {
      registered = this.backend.register(accelerator, this.onToggle);
    } catch {
      invalid = true;
    }
    if (!registered) {
      const state = {
        accelerator,
        healthy: false,
        error: invalid
          ? 'That shortcut is invalid.'
          : 'That shortcut is already in use.',
      };
      if (!previousHealthy) this.publish(state);
      return state;
    }
    this.accelerator = accelerator;
    this.healthy = true;
    if (previous && previous !== accelerator) this.unregister(previous);
    return this.publish({ accelerator, healthy: true });
  }

  stop(): void {
    const wasRegistered = Boolean(this.accelerator) || this.healthy;
    this.unregisterCurrent();
    if (wasRegistered) this.publish({ healthy: false });
  }

  private unregisterCurrent(): void {
    if (this.accelerator) this.unregister(this.accelerator);
    this.accelerator = undefined;
    this.healthy = false;
  }

  private unregister(accelerator: string): void {
    try {
      this.backend.unregister(accelerator);
    } catch {
      // A failed unregister must not leave the shortcut marked healthy.
    }
  }

  private publish(state: GlobalShortcutState): GlobalShortcutState {
    this.healthy = state.healthy;
    this.onState(state);
    return state;
  }
}
