/**
 * Tracks startup initialization state and coordinates async waiters.
 * Waiters are settled exactly once as either ready (resolve) or failed (reject).
 */
export class InitGate {
  private settled = false
  private readonly promise: Promise<void>
  private resolvePromise!: () => void
  private rejectPromise!: (error: unknown) => void

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
  }

  wait(): Promise<void> {
    return this.promise
  }

  markReady(): void {
    if (this.settled) return
    this.settled = true
    this.resolvePromise()
  }

  markFailed(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.rejectPromise(error)
  }
}
