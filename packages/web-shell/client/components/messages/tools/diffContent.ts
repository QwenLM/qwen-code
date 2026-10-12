import { escapePreviewText } from '../../../adapters/transcriptAdapter';
import { sanitizeControlChars } from '../toolFormatting';

// Both diff renderers mark the same invisible characters, without rewriting
// the underlying CodeMirror document or mistaking literal escape text for one.
export const DIFF_INVISIBLE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- This renderer makes control characters visible.
  /([\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\p{Cf}])/gu;

export function escapeDiffContent(content: string): string {
  return escapePreviewText(sanitizeControlChars(content));
}
