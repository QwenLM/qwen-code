/**
 * Tracks permission denials per tool across a session and provides escalating
 * context messages to help the model avoid futile retries.
 */

/** Threshold after which denial messages include "try a different approach" guidance. */
const SOFT_THRESHOLD = 2;

/** Threshold after which denial messages strongly suggest stopping retries. */
const HARD_THRESHOLD = 4;

interface DenialRecord {
  /** Total denials for this tool across the entire session. */
  sessionTotal: number;
  /** Denials for this tool in the current agentic turn. */
  turnCount: number;
}

export class PermissionDenialTracker {
  private denials = new Map<string, DenialRecord>();

  /**
   * Records a permission denial for the given tool and returns an augmented
   * error message if the denial count has crossed a threshold.
   *
   * @param toolName - The tool that was denied.
   * @param originalMessage - The original denial error message.
   * @returns The original message, possibly with escalating guidance appended.
   */
  recordDenial(toolName: string, originalMessage: string): string {
    const record = this.denials.get(toolName) ?? {
      sessionTotal: 0,
      turnCount: 0,
    };
    record.sessionTotal++;
    record.turnCount++;
    this.denials.set(toolName, record);

    const count = record.sessionTotal;

    if (count >= HARD_THRESHOLD) {
      return (
        `${originalMessage}\n\n` +
        `[This tool has been denied ${count} times this session. ` +
        `STOP retrying this tool. Ask the user for guidance or use a different approach entirely.]`
      );
    }

    if (count >= SOFT_THRESHOLD) {
      return (
        `${originalMessage}\n\n` +
        `[This tool has been denied ${count} times this session. ` +
        `Consider trying a different approach instead of retrying.]`
      );
    }

    return originalMessage;
  }

  /**
   * Resets per-turn counters. Call this at the start of each agentic turn
   * so that turn-level counts stay accurate while session totals accumulate.
   */
  resetTurn(): void {
    for (const record of this.denials.values()) {
      record.turnCount = 0;
    }
  }

  /** Returns the session-level denial count for a given tool. */
  getDenialCount(toolName: string): number {
    return this.denials.get(toolName)?.sessionTotal ?? 0;
  }

  /** Returns all tools that have been denied at least once, with their counts. */
  getSummary(): Map<string, number> {
    const summary = new Map<string, number>();
    for (const [tool, record] of this.denials) {
      summary.set(tool, record.sessionTotal);
    }
    return summary;
  }

  /** Fully resets all tracking state. */
  reset(): void {
    this.denials.clear();
  }
}
