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

function isModelsPath(url: string): boolean {
  return /\/models(\/|$|\?)/.test(new URL(url).pathname);
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

export function wrapFetchWithCopilotAuth(
  tokenMgr: CopilotTokenManager,
  opts?: { fetchImpl?: typeof fetch },
): typeof fetch {
  const f = opts?.fetchImpl ?? fetch;

  return async (input: URL | string | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const body = init?.body ? String(init.body) : '';

    let forceRefreshCount = 0;
    let res: Response;

    const doRequest = async (): Promise<Response> => {
      const snap = await tokenMgr.getSnapshot();
      const rewrittenUrl = rewriteHost(url, snap.endpointsApi);

      // Use Headers for robust merge of caller-provided headers, then
      // materialize to a plain Record so consumers/tests can read by key.
      const merged = new Headers(init?.headers);
      const headers: Record<string, string> = {};
      merged.forEach((v, k) => {
        headers[k] = v;
      });

      // Ruling 6: bearer is a RedactedString whose toString() returns
      // '[redacted]'; use valueOf() to get the primitive.
      headers['Authorization'] = `Bearer ${snap.bearer.valueOf()}`;
      headers['copilot-integration-id'] =
        STATIC_HEADERS['copilot-integration-id'];
      headers['editor-version'] = STATIC_HEADERS['editor-version'];
      headers['editor-plugin-version'] =
        STATIC_HEADERS['editor-plugin-version'];
      headers['user-agent'] = STATIC_HEADERS['user-agent'];
      headers['x-initiator'] = 'user';

      if (isMessagesPath(rewrittenUrl)) {
        headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
      }
      if (isModelsPath(rewrittenUrl)) {
        headers['X-GitHub-Api-Version'] = '2022-11-28';
      }
      if (hasImageInBody(body)) {
        headers['Copilot-Vision-Request'] = 'true';
      }

      return f(rewrittenUrl, { ...init, headers, body: body || undefined });
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
