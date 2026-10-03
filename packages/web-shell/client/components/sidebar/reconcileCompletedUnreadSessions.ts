export function reconcileCompletedUnreadSessions(
  previousRunning: ReadonlyMap<string, boolean> | null,
  running: ReadonlyMap<string, boolean>,
  currentSessionIdentity: string | null,
) {
  const add: string[] = [];
  const remove: string[] = [];
  if (currentSessionIdentity) remove.push(currentSessionIdentity);
  for (const [identity, isRunning] of running) {
    if (isRunning) {
      // Repeated running snapshots may predate another tab's completion.
      if (previousRunning?.get(identity) !== true) remove.push(identity);
    } else if (
      previousRunning?.get(identity) === true &&
      identity !== currentSessionIdentity
    ) {
      add.push(identity);
    }
  }
  // Catalogs can be filtered or paginated; absence does not prove deletion.
  return { add, remove };
}
