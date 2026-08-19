import type { DaemonWorkspaceActions } from '@qwen-code/webui/daemon-react-sdk';
import { readWorkspaceFileAsText } from './artifactUtils';

const ENDPOINT_STORAGE_KEY = 'qwen-web-shell-share-endpoint';
const TOKEN_STORAGE_KEY = 'qwen-web-shell-share-token';

const MAX_SHARE_BYTES = 5 * 1024 * 1024;

export interface ShareTarget {
  endpoint: string;
  token?: string;
}

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]')
  );
}

/**
 * Plain http would put the bearer token and the artifact on the wire in the
 * clear, so only https survives — except on loopback, where there is no wire.
 */
export function parseShareEndpoint(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) return undefined;
  return url.toString();
}

export function readShareTarget(): ShareTarget | undefined {
  try {
    const endpoint = parseShareEndpoint(
      window.localStorage.getItem(ENDPOINT_STORAGE_KEY) ?? '',
    );
    if (!endpoint) return undefined;
    return {
      endpoint,
      token: window.localStorage.getItem(TOKEN_STORAGE_KEY) || undefined,
    };
  } catch {
    return undefined;
  }
}

export function storeShareTarget(target: ShareTarget): void {
  try {
    window.localStorage.setItem(ENDPOINT_STORAGE_KEY, target.endpoint);
    if (target.token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, target.token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures in private browsing or locked-down browsers.
  }
}

export function parseShareResponseUrl(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  const value = (payload as { url?: unknown } | null)?.url;
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === 'https:' || url.protocol === 'http:'
    ? url.toString()
    : undefined;
}

/**
 * Uploads the artifact to the configured endpoint and returns the public URL
 * it reports back. The endpoint contract is deliberately generic — POST the
 * HTML, answer with `{"url": "..."}` — so any host can serve it.
 */
export async function publishHtmlArtifact(
  workspaceActions: Pick<DaemonWorkspaceActions, 'readFileBytes' | 'stat'>,
  workspacePath: string,
  target: ShareTarget,
  isCancelled?: () => boolean,
): Promise<string> {
  const html = await readWorkspaceFileAsText(
    (filePath, opts) => workspaceActions.readFileBytes(filePath, opts),
    workspacePath,
    {
      statFile: (filePath) => workspaceActions.stat(filePath),
      isCancelled,
      maxBytes: MAX_SHARE_BYTES,
    },
  );
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
    },
    body: html,
  });
  if (!response.ok) {
    throw new Error(
      `Share endpoint returned ${response.status} ${response.statusText}`.trim(),
    );
  }
  const url = parseShareResponseUrl(await response.text());
  if (!url) {
    throw new Error('Share endpoint did not return a usable URL.');
  }
  return url;
}
