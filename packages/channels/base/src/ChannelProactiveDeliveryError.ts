export type ChannelProactiveDeliveryDisposition = 'permanent' | 'transient';

export const CHANNEL_PROACTIVE_DELIVERY_ERROR_CODE =
  'channel_proactive_delivery_error' as const;

/**
 * Stable adapter-to-daemon delivery classification. Messages are diagnostics;
 * callers must branch on disposition rather than matching platform text.
 */
export class ChannelProactiveDeliveryError extends Error {
  readonly code = CHANNEL_PROACTIVE_DELIVERY_ERROR_CODE;

  constructor(
    readonly disposition: ChannelProactiveDeliveryDisposition,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChannelProactiveDeliveryError';
  }
}

/** Recognizes errors across separately installed Channel extension packages. */
export function isChannelProactiveDeliveryError(
  error: unknown,
): error is ChannelProactiveDeliveryError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    disposition?: unknown;
    message?: unknown;
  };
  return (
    candidate.code === CHANNEL_PROACTIVE_DELIVERY_ERROR_CODE &&
    (candidate.disposition === 'permanent' ||
      candidate.disposition === 'transient') &&
    typeof candidate.message === 'string'
  );
}
