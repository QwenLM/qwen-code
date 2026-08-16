// packages/core/src/copilot/copilot-models.ts
import type { CopilotTokenManager } from './copilot-auth.js';
import type { CopilotWire } from './copilot-route.js';

export interface CopilotModel {
  slug: string;
  wire: CopilotWire;
  contextWindow?: number;
  maxOutput?: number;
}

export async function fetchCopilotModels(
  _tokenMgr: CopilotTokenManager,
  _opts?: { fetchImpl?: typeof fetch },
): Promise<CopilotModel[] | null> {
  throw new Error('not implemented');
}

export async function enableAllCopilotModels(
  _tokenMgr: CopilotTokenManager,
  _opts?: { fetchImpl?: typeof fetch },
): Promise<void> {
  throw new Error('not implemented');
}
