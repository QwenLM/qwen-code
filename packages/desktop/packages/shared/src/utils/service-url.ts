/**
 * Service URL utilities - browser-safe (no Node.js dependencies)
 *
 * This module is safe to import in browser/renderer contexts.
 * For logo URL resolution, use the IPC-based getLogoUrl from the main process.
 */

/**
 * Derive a service URL from source config for favicon resolution.
 * For stdio sources (no URL), falls back to https://{provider}.com
 *
 * This is a pure function safe for both Node.js and browser contexts.
 */
export function deriveServiceUrl(
  config: {
    mcp?: { url?: string };
    api?: { baseUrl?: string; googleService?: string };
    provider?: string;
  }
): string | null {
  // Get URL from config (API baseUrl takes precedence)
  let url = config.api?.baseUrl ?? config.mcp?.url ?? null;

  // For stdio sources (no URL), try provider name as domain
  if (!url && config.provider) {
    url = `https://${config.provider}.com`;
  }

  return url;
}
