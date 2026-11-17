import type { ChatCapabilities } from './contract.js';

export type ChatRegion = keyof ChatCapabilities;

export function regionsToCapabilities(
  regions: Iterable<ChatRegion>,
): ChatCapabilities {
  const capabilities: Record<ChatRegion, boolean> = {
    contextUsage: false,
    usageStats: false,
    modelSelection: false,
    approvalSelection: false,
    sessionOps: false,
    conversationSearch: false,
    goalDisplay: false,
    terminal: false,
    tasks: false,
    diagnostics: false,
    artifacts: false,
  };
  for (const region of regions) {
    capabilities[region] = true;
  }
  return capabilities;
}
