export class HostAudioLifecycle {
  private queue = Promise.resolve();
  private generation = 0;

  activate(operation: () => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    return this.enqueue(generation, operation);
  }

  runIfCurrent(operation: () => Promise<void>): Promise<void> {
    return this.enqueue(this.generation, operation);
  }

  deactivate(
    deactivateNow: () => void,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    this.generation += 1;
    deactivateNow();
    return this.enqueue(undefined, cleanup);
  }

  private enqueue(
    generation: number | undefined,
    operation: () => Promise<void>,
  ): Promise<void> {
    const pending = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (generation !== undefined && generation !== this.generation) return;
        await operation();
      });
    this.queue = pending;
    return pending;
  }
}
