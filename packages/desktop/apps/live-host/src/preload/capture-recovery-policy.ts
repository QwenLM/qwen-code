export class CaptureRecoveryPolicy {
  private attempt = 0;

  constructor(
    private readonly delaysMs: readonly number[] = [100, 500, 1_500],
  ) {}

  nextDelayMs(): number | undefined {
    const delay = this.delaysMs[this.attempt];
    if (delay === undefined) return undefined;
    this.attempt += 1;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}
