/**
 * Custom error to signal that a stream completed with invalid content,
 * which should trigger a retry.
 */
export class InvalidStreamError extends Error {
  readonly type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT' | 'PROTOCOL_TAG_LEAK';

  constructor(
    message: string,
    type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT' | 'PROTOCOL_TAG_LEAK',
  ) {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}
