export class BoundedReconnectPolicy {
  private attempt = 0;

  constructor(
    private readonly delaysMs: readonly number[] = [
      250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ],
    private readonly jitterFraction = 0.2,
    private readonly random: () => number = Math.random,
  ) {}

  nextDelayMs(): number | undefined {
    const base = this.delaysMs[this.attempt];
    if (base === undefined) return undefined;
    this.attempt += 1;
    const jitter = base * this.jitterFraction * (this.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  reset(): void {
    this.attempt = 0;
  }

  get attemptsUsed(): number {
    return this.attempt;
  }
}
