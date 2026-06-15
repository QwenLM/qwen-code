import { debug } from '../utils/debug.ts';
import type { AgentError } from '../agent/errors.ts';

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  typedError?: AgentError;
}

export async function validateMcpUrl(url: string): Promise<UrlValidationResult> {
  debug('[url-validator] Validating URL:', url);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Enter a valid HTTPS URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'The URL must use https://.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'The URL must not include a username or password.' };
  }

  if (parsed.hostname !== 'mcp.craft.do') {
    return { valid: false, error: 'The URL must be hosted on mcp.craft.do.' };
  }

  const match = parsed.pathname.match(/^\/links\/([A-Za-z0-9_-]+)\/mcp\/?$/);
  if (!match) {
    return { valid: false, error: 'The URL path must look like /links/{id}/mcp.' };
  }

  return { valid: true };
}
