// packages/core/src/copilot/copilot-auth.ts
export interface CopilotAuthSnapshot {
  readonly bearer: string;
  readonly endpointsApi: string;
  readonly expiresAtMs: number;
}

export interface CopilotTokenManager {
  getSnapshot(): Promise<CopilotAuthSnapshot>;
  forceRefresh(): Promise<void>;
  getAvailableModelIds(): Promise<string[] | null>;
}

export interface DiscoveredToken {
  token: string;
  source: string;
}

export async function discoverGithubToken(_opts?: {
  overridePath?: string;
}): Promise<DiscoveredToken> {
  throw new Error('not implemented');
}

export async function exchangeGhuForCapi(
  _ghu: string,
  _opts?: { fetchImpl?: typeof fetch; githubApiBase?: string },
): Promise<{ bearer: string; endpointsApi: string; expiresAtMs: number }> {
  throw new Error('not implemented');
}

export function parseProxyEp(bearer: string): string | null {
  const match = bearer.match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const host = match[1].replace(/^proxy\./, 'api.');
  return `https://${host}`;
}

export function createCopilotTokenManager(_opts?: {
  cacheFile?: string | false;
  fetchImpl?: typeof fetch;
}): CopilotTokenManager {
  throw new Error('not implemented');
}

export async function runCopilotDeviceFlow(_opts?: {
  signal?: AbortSignal;
  domain?: string;
  fetchImpl?: typeof fetch;
  notify?: (event: CopilotDeviceFlowEvent) => void;
}): Promise<{ token: string }> {
  throw new Error('not implemented');
}

export type CopilotDeviceFlowEvent =
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds: number;
      expiresInSeconds: number;
    }
  | { type: 'progress'; message: string }
  | { type: 'error'; message: string };
