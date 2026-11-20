/**
 * Neutral mirror of the SDK's permission-mode vocabulary, for shared
 * composer code that must not value-import the daemon SDK. The parity test
 * pins this list against `DAEMON_APPROVAL_MODES`; update both together.
 */
export const APPROVAL_MODES = [
  'plan',
  'default',
  'auto-edit',
  'auto',
  'yolo',
] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];
