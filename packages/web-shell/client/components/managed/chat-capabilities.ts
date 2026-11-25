import type { ManagedAgentSessionSummary } from './managed-agent-provider.js';
import type { ChatCapabilities } from '../../chat-core/contract.js';
import {
  regionsToCapabilities,
  type ChatRegion,
} from '../../chat-core/capabilities.js';

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

const MANAGED_CAPABILITY_KEYS = Object.keys(
  MANAGED_CHAT_CAPABILITY_MAP,
) as readonly ManagedCapabilityKey[];

export function managedCapabilitiesFromSummary(
  capabilities: Partial<ManagedAgentSessionSummary['capabilities']> | undefined,
): ChatCapabilities {
  if (!capabilities) return regionsToCapabilities([]);
  const regions = new Set<ChatRegion>();
  for (const key of MANAGED_CAPABILITY_KEYS) {
    if (isManagedCapabilityOn(capabilities[key])) {
      for (const region of MANAGED_CHAT_CAPABILITY_MAP[key]) {
        regions.add(region);
      }
    }
  }
  return regionsToCapabilities(regions);
}
