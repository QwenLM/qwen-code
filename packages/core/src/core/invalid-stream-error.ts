/**
 * Custom error to signal that a stream completed with invalid content,
 * which should trigger a retry.
 */
export class InvalidStreamError extends Error {
  readonly type:
    | 'NO_FINISH_REASON'
    | 'NO_RESPONSE_TEXT'
    | 'PROTOCOL_TAG_LEAK'
    | 'MALFORMED_TOOL_CALL';

  constructor(message: string, type: InvalidStreamError['type']) {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}
