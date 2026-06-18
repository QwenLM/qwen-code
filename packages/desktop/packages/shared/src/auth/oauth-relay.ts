import type { PreparedOAuthFlow } from './oauth-flow-types.ts';

export const OAUTH_RELAY_CALLBACK_URL = 'https://agents.craft.do/auth/callback';
const OAUTH_RELAY_STATE_PREFIX = 'ca1.';
const OAUTH_RELAY_STATE_VERSION = 1;

interface OAuthRelayStateEnvelope {
  v: number;
  r: string;
  s: string;
}

export interface OAuthRelayState {
  returnTo: string;
  innerState: string;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function isOAuthRelayState(value: string): boolean {
  return value.startsWith(OAUTH_RELAY_STATE_PREFIX);
}

export function encodeOAuthRelayState(returnTo: string, innerState: string): string {
  const envelope: OAuthRelayStateEnvelope = {
    v: OAUTH_RELAY_STATE_VERSION,
    r: returnTo,
    s: innerState,
  };
  return `${OAUTH_RELAY_STATE_PREFIX}${toBase64Url(JSON.stringify(envelope))}`;
}

export function decodeOAuthRelayState(value: string): OAuthRelayState {
  if (!isOAuthRelayState(value)) {
    throw new Error('State does not use the OAuth relay envelope');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value.slice(OAUTH_RELAY_STATE_PREFIX.length)));
  } catch {
    throw new Error('Invalid OAuth relay state');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('v' in parsed) || parsed.v !== OAUTH_RELAY_STATE_VERSION ||
    !('r' in parsed) || typeof parsed.r !== 'string' || parsed.r.length === 0 ||
    !('s' in parsed) || typeof parsed.s !== 'string' || parsed.s.length === 0
  ) {
    throw new Error('Invalid OAuth relay state');
  }

  return {
    returnTo: parsed.r,
    innerState: parsed.s,
  };
}

export function wrapPreparedOAuthFlowForRelay(
  prepared: PreparedOAuthFlow,
  returnTo: string,
): PreparedOAuthFlow {
  const authUrl = new URL(prepared.authUrl);
  authUrl.searchParams.set('redirect_uri', OAUTH_RELAY_CALLBACK_URL);
  authUrl.searchParams.set('state', encodeOAuthRelayState(returnTo, prepared.state));

  return {
    ...prepared,
    authUrl: authUrl.toString(),
    redirectUri: OAUTH_RELAY_CALLBACK_URL,
  };
}
