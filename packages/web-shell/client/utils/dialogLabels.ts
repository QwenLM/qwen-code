import { cleanMetadataLine } from './scheduledTaskRunContent';

export function trimDialogLabel(label: string): string {
  return label.replace(/[：:\s]+$/u, '');
}

/**
 * The whole invisible class — control, format, and default-ignorable code
 * points — decides whether a label reduces to nothing. Hand-listing its
 * members always misses one (zero-width space, soft hyphen, word joiner,
 * Hangul filler, tag characters), and a stored name made of nothing but
 * such marks is truthy yet renders as nothing, so it must reduce to '' here
 * and let the caller fall back. The class only judges emptiness: it is NOT
 * stripped from a non-empty label, because Cf includes the load-bearing
 * ZWJ/ZWNJ inside emoji sequences and Indic conjuncts.
 */
const DIALOG_LABEL_INVISIBLE_REGEX =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Strip terminal escape sequences and control/bidi marks from a label
 * destined for a dialog (cleanMetadataLine), then collapse whitespace; a
 * label with no visible code point at all reduces to ''. */
export function cleanDialogLabel(label: string): string {
  const cleaned = cleanMetadataLine(label);
  return cleaned.replace(DIALOG_LABEL_INVISIBLE_REGEX, '').trim() === ''
    ? ''
    : cleaned;
}
