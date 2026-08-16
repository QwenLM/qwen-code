// packages/core/src/copilot/copilot-auth.ts
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export class CopilotTokenNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotTokenNotFoundError';
  }
}

function isCopilotToken(t: string): boolean {
  return t.startsWith('ghu_') || t.startsWith('gho_');
}

function extractGhuFromJson(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;

  // hosts.json: { "github.com:Iv1.xxx": { oauth_token | token } }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const tok = (v['oauth_token'] ?? v['token']) as string | undefined;
      if (typeof tok === 'string' && isCopilotToken(tok)) return tok;
    }
  }
  // VS Code: { accounts: [{ token }] }
  if (Array.isArray(obj['accounts'])) {
    for (const acc of obj['accounts']) {
      if (
        acc &&
        typeof acc === 'object' &&
        typeof (acc as Record<string, unknown>)['token'] === 'string'
      ) {
        const tok = (acc as Record<string, string>)['token'];
        if (isCopilotToken(tok)) return tok;
      }
    }
  }
  // flat: { token | oauth_token }
  const flatTok = (obj['oauth_token'] ?? obj['token']) as string | undefined;
  if (typeof flatTok === 'string' && isCopilotToken(flatTok)) return flatTok;

  // Copilot CLI: { copilotTokens: { "https://github.com:login": "gho_..." } }
  if (obj['copilotTokens'] && typeof obj['copilotTokens'] === 'object') {
    for (const v of Object.values(
      obj['copilotTokens'] as Record<string, unknown>,
    )) {
      if (typeof v === 'string' && isCopilotToken(v)) return v;
    }
  }
  return null;
}

function defaultSearchPaths(): string[] {
  const home = homedir();
  const paths = [
    join(home, '.config', 'github-copilot', 'hosts.json'),
    join(home, '.config', 'github-copilot', 'apps.json'),
    join(home, '.copilot', 'config.json'),
  ];
  // VS Code paths (platform-aware)
  if (process.platform === 'darwin') {
    paths.push(
      join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'github.copilot',
        'hosts.json',
      ),
    );
  } else if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    paths.push(
      join(
        appdata,
        'Code',
        'User',
        'globalStorage',
        'github.copilot',
        'hosts.json',
      ),
    );
  } else {
    paths.push(
      join(
        home,
        '.config',
        'Code',
        'User',
        'globalStorage',
        'github.copilot',
        'hosts.json',
      ),
    );
  }
  return paths;
}

export async function discoverGithubToken(opts?: {
  overridePath?: string;
}): Promise<DiscoveredToken> {
  // 1. $GITHUB_TOKEN env (only ghu_/gho_ prefix)
  const envToken = process.env['GITHUB_TOKEN'];
  if (envToken && isCopilotToken(envToken)) {
    return { token: envToken, source: 'GITHUB_TOKEN env' };
  }

  // 2. override path or $COPILOT_GITHUB_TOKEN_PATH
  const overridePath =
    opts?.overridePath ?? process.env['COPILOT_GITHUB_TOKEN_PATH'];
  const paths = overridePath ? [overridePath] : defaultSearchPaths();

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8');
      const tok = extractGhuFromJson(JSON.parse(raw));
      if (tok) return { token: tok, source: p };
    } catch {
      // file missing or invalid — try next
    }
  }

  throw new CopilotTokenNotFoundError(
    'No GitHub Copilot token (ghu_/gho_) found. Run /auth to start device flow, or install gh/VS Code Copilot.',
  );
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
