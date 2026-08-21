import type { CopilotTokenManager } from './copilot-auth.js';

export const COPILOT_SENTINEL_BASE_URL =
  'https://copilot-endpoint-rewritten-by-fetch.invalid';

const STATIC_HEADERS = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': 'qwen-code/0.1',
  'editor-plugin-version': 'copilot-chat/0.35.0',
  'user-agent': 'GitHubCopilotChat/0.35.0',
} as const;

const MAX_FORCE_REFRESH_PER_REQUEST = 1;

function rewriteHost(url: string, endpointsApi: string): string {
  const parsed = new URL(url);
  const epParsed = new URL(endpointsApi);
  parsed.protocol = epParsed.protocol;
  parsed.host = epParsed.host;
  return parsed.toString();
}

function isMessagesPath(url: string): boolean {
  return /\/(v1\/)?messages/.test(new URL(url).pathname);
}

function hasImageInBody(body: string): boolean {
  try {
    const normalized = JSON.stringify(JSON.parse(body));
    return (
      normalized.includes('image_url') ||
      normalized.includes('input_image') ||
      normalized.includes('"image"')
    );
  } catch {
    return false;
  }
}

function addCopilotHeaders(
  headers: Headers,
  bearer: string,
  url: string,
  body: string,
): void {
  // Delete any caller-provided Authorization first so CAPI receives only
  // the Copilot bearer.
  headers.delete('authorization');

  // Ruling 6: bearer is a RedactedString whose toString() returns
  // '[redacted]'; use valueOf() to get the primitive.
  headers.set('Authorization', `Bearer ${bearer.valueOf()}`);
  headers.set(
    'copilot-integration-id',
    STATIC_HEADERS['copilot-integration-id'],
  );
  headers.set('editor-version', STATIC_HEADERS['editor-version']);
  headers.set('editor-plugin-version', STATIC_HEADERS['editor-plugin-version']);
  headers.set('user-agent', STATIC_HEADERS['user-agent']);
  headers.set('x-initiator', 'user');

  if (isMessagesPath(url)) {
    headers.set('anthropic-beta', 'prompt-caching-2024-07-31');
  }
  if (hasImageInBody(body)) {
    headers.set('Copilot-Vision-Request', 'true');
  }
}

export function wrapFetchWithCopilotAuth(
  tokenMgr: CopilotTokenManager,
  opts?: { fetchImpl?: typeof fetch },
): typeof fetch {
  const f = opts?.fetchImpl ?? fetch;

  return async (input: URL | string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : null;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : request!.url;
    const body = typeof init?.body === 'string' ? init.body : '';

    let forceRefreshCount = 0;
    let res: Response;

    const doRequest = async (): Promise<Response> => {
      const snap = await tokenMgr.getSnapshot();
      const rewrittenUrl = rewriteHost(url, snap.endpointsApi);

      if (request) {
        const outgoing = new Request(rewrittenUrl, request.clone());
        addCopilotHeaders(outgoing.headers, snap.bearer, rewrittenUrl, body);
        return f(outgoing);
      }

      const headers = new Headers(init?.headers);
      addCopilotHeaders(headers, snap.bearer, rewrittenUrl, body);
      const fetchHeaders = Object.fromEntries(headers);
      const authorization = fetchHeaders['authorization'];
      if (authorization) {
        delete fetchHeaders['authorization'];
        fetchHeaders['Authorization'] = authorization;
      }

      return f(rewrittenUrl, { ...init, headers: fetchHeaders });
    };

    res = await doRequest();

    if (
      res.status === 401 &&
      forceRefreshCount < MAX_FORCE_REFRESH_PER_REQUEST
    ) {
      forceRefreshCount++;
      await tokenMgr.forceRefresh();
      res = await doRequest();
    }

    if (res.status === 429) {
      const retryAfter =
        res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset');
      process.stderr.write(
        `[copilot] rate limited: retry after ${retryAfter ?? 'unknown'}s\n`,
      );
    }

    return res;
  };
}
