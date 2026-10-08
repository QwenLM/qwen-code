export const SESSION_LIVE_STATE_POLL_MS = 5_000;

export function resolveSessionLiveStatePollInterval(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1_000 &&
    value <= 2_147_483_647
    ? value
    : SESSION_LIVE_STATE_POLL_MS;
}
