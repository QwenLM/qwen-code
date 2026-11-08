import type { TurnOutputFileChange } from './TurnOutputs';

export function LineStats({
  additions,
  deletions,
  className,
  additionsClassName,
  deletionsClassName,
}: {
  additions: number | undefined;
  deletions: number | undefined;
  className: string;
  additionsClassName: string;
  deletionsClassName: string;
}) {
  if (additions === undefined || deletions === undefined) return null;
  return (
    <span className={className}>
      <span className={additionsClassName}>+{additions}</span>
      <span className={deletionsClassName}>-{deletions}</span>
    </span>
  );
}

export function sumLineStats(changes: readonly TurnOutputFileChange[]) {
  if (
    changes.some(
      (change) =>
        change.additions === undefined || change.deletions === undefined,
    )
  ) {
    return undefined;
  }
  return changes.reduce(
    (sum, change) => ({
      additions: sum.additions + (change.additions ?? 0),
      deletions: sum.deletions + (change.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}
