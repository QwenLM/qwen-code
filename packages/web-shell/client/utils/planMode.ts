import { APPROVAL_MODES } from '../constants/approvalModes.js';

export type WebShellApprovalMode = Exclude<
  (typeof APPROVAL_MODES)[number],
  'plan'
>;

export const EXECUTION_APPROVAL_MODES = APPROVAL_MODES.filter(
  (mode) => mode !== 'plan',
);

export function resolveApprovalModes(
  value: unknown,
): readonly WebShellApprovalMode[] {
  if (!Array.isArray(value)) return EXECUTION_APPROVAL_MODES;
  return EXECUTION_APPROVAL_MODES.filter((mode) => value.includes(mode));
}

export function nextApprovalMode(
  available: readonly WebShellApprovalMode[],
  current: string,
): WebShellApprovalMode | undefined {
  // findIndex, not indexOf: narrowing `current` to the tuple member type
  // silently degrades when the SDK's declaration bundle leaves its
  // permission-mode import dangling, and the build must survive both states.
  const idx = available.findIndex((mode) => mode === current);
  const next = available[(idx + 1) % available.length];
  return next && next !== current ? next : undefined;
}

export function parsePlanCommand(
  args: string,
  enabled: boolean,
): { enabled: boolean; prompt?: string } {
  const prompt = args.trim();
  switch (prompt.toLowerCase()) {
    case '':
      return { enabled: !enabled };
    case 'on':
      return { enabled: true };
    case 'off':
    case 'exit':
      return { enabled: false };
    default:
      return { enabled: true, prompt };
  }
}
