export function trimDialogLabel(label: string): string {
  return label.replace(/[：:\s]+$/u, '');
}

/* eslint-disable no-control-regex -- a label sanitizer strips raw control bytes */
const DIALOG_LABEL_STRIP_REGEX =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

/** Strip terminal control bytes and Unicode bidi marks from a label destined
 * for a dialog, then collapse whitespace. A name made of nothing but such
 * marks is truthy yet renders as nothing (or actively reorders the surrounding
 * sentence), so it must reduce to '' here and let the caller fall back. */
export function cleanDialogLabel(label: string): string {
  return label
    .replace(DIALOG_LABEL_STRIP_REGEX, '')
    .trim()
    .replace(/\s+/g, ' ');
}
