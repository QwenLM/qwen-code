// packages/core/src/copilot/copilot-route.ts
export type CopilotWire = 'messages' | 'responses' | 'chat';

/**
 * Thrown when a Copilot model slug cannot be routed to any wire. With
 * pattern-based routing this should not occur in practice — every slug matches
 * a pattern or falls back to the `chat` wire — but the type is retained so
 * callers can distinguish a routing failure from a generic error.
 */
export class CopilotRouteError extends Error {
  constructor(slug: string, reason: string) {
    super(`Cannot route Copilot model "${slug}": ${reason}`);
    this.name = 'CopilotRouteError';
  }
}

function baseSlug(slug: string): string {
  // Strip a provider-namespace prefix (e.g. "anthropic." in
  // "anthropic.claude-opus-4.6"). A prefix is a single word with no dash before
  // the first dot; model slugs like "claude-opus-4.6" contain dashes and version
  // dots that must be preserved intact.
  const dot = slug.indexOf('.');
  if (dot < 0) return slug;
  const prefix = slug.slice(0, dot);
  return prefix.includes('-') ? slug : slug.slice(dot + 1);
}

export function routeForModel(
  slug: string,
  warn?: (msg: string) => void,
  liveModels?: Map<string, CopilotWire>,
): CopilotWire {
  const base = baseSlug(slug);

  // Tier 1: live catalog — an explicit per-slug override always wins.
  if (liveModels?.has(base)) {
    return liveModels.get(base)!;
  }

  // Tier 2: pattern-based routing. New models in a known family route
  // correctly without code changes — claude-* is messages-only on CAPI,
  // gpt-5* uses the OpenAI Responses API.
  if (base.startsWith('claude-')) return 'messages';
  if (base.startsWith('gpt-5')) return 'responses';

  // Tier 3: unknown family — fall back to chat and warn so drift is visible.
  warn?.(`[copilot] unknown model "${slug}" — defaulting to chat wire`);
  return 'chat';
}
