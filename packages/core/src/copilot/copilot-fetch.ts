// packages/core/src/copilot/copilot-fetch.ts
import type { CopilotTokenManager } from './copilot-auth.js';

export const COPILOT_SENTINEL_BASE_URL =
  'https://copilot-endpoint-rewritten-by-fetch.invalid';

export function wrapFetchWithCopilotAuth(
  _tokenMgr: CopilotTokenManager,
  _opts?: { fetchImpl?: typeof fetch },
): typeof fetch {
  throw new Error('not implemented');
}
