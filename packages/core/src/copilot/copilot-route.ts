// packages/core/src/copilot/copilot-route.ts
export type CopilotWire = 'messages' | 'responses' | 'chat';

export class CopilotRouteError extends Error {
  constructor(slug: string, reason: string) {
    super(`Cannot route Copilot model "${slug}": ${reason}`);
    this.name = 'CopilotRouteError';
  }
}

const CLAUDE_MESSAGES_SLUGS = new Set([
  'claude-opus-4.6',
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.7',
  'claude-haiku-4.5',
]);

const GPT5_RESPONSES_SLUGS = new Set([
  'gpt-5',
  'gpt-5.1',
  'gpt-5.2',
  'gpt-5.4',
  'gpt-5-mini',
  'gpt-5-codex',
]);

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

  // Tier 1: live catalog
  if (liveModels?.has(base)) {
    return liveModels.get(base)!;
  }

  // Tier 2: static allowlists
  if (CLAUDE_MESSAGES_SLUGS.has(base)) return 'messages';
  if (GPT5_RESPONSES_SLUGS.has(base)) return 'responses';

  // Tier 3: drift policy
  if (base.startsWith('claude-')) {
    throw new CopilotRouteError(
      slug,
      'unknown claude-* model; CAPI is messages-only for Claude',
    );
  }
  if (base.startsWith('gpt-5') && !base.endsWith('-chat')) {
    throw new CopilotRouteError(
      slug,
      'unknown gpt-5* model; CAPI is responses-only for gpt-5 (non -chat)',
    );
  }

  warn?.(`[copilot] unknown model "${slug}" — defaulting to chat wire`);
  return 'chat';
}
