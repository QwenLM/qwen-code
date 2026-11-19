import type { ManagedAgentSessionSummary } from './managed-agent-provider.js';
import type { ChatRegion } from '../../chat-core/capabilities.js';

export type ManagedCapabilityKey =
  keyof ManagedAgentSessionSummary['capabilities'];

// Exhaustive over the managed capability record; the key-set fixture test
// pins the same fact at runtime.
export const MANAGED_CHAT_CAPABILITY_MAP: Record<
  ManagedCapabilityKey,
  readonly ChatRegion[]
> = {
  canSend: [],
  canCancel: [],
  canRename: ['sessionOps'],
  sessionClose: ['sessionOps'],
  sessionArchive: ['sessionOps'],
  sessionUnarchive: ['sessionOps'],
  sessionDelete: ['sessionOps'],
  actions: [],
  childAgents: ['tasks'],
  tasks: ['tasks'],
  diagnostics: ['diagnostics'],
  artifacts: ['artifacts'],
  workspaceTurns: [],
  modelChange: ['modelSelection'],
  contextCompression: ['contextUsage'],
  approvalModeChange: ['approvalSelection'],
  inputAttachments: [],
  btw: [],
  recap: [],
  terminal: ['terminal'],
  clientFiles: [],
};

// The managed `terminal` capability is tri-state (boolean | null): null and
// undefined mean unknown, which hides the region rather than guessing.
export function isManagedCapabilityOn(
  value: boolean | null | undefined,
): boolean {
  return value === true;
}
