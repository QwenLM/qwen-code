export type ChannelProactiveDeliveryDisposition = 'permanent' | 'transient';

/**
 * Stable adapter-to-daemon delivery classification. Messages are diagnostics;
 * callers must branch on disposition rather than matching platform text.
 */
export class ChannelProactiveDeliveryError extends Error {
  constructor(
    readonly disposition: ChannelProactiveDeliveryDisposition,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChannelProactiveDeliveryError';
  }
}
