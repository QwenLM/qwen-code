import type { components } from './generated/managed-agent-api';

type Schemas = components['schemas'];

export type JavaAgentDate = number | string;

export type JavaAgentTurn = Schemas['WebShellTurn'];

export interface JavaAgentEnvironment {
  environmentId?: string;
  state?: string;
  errorCode?: string;
}

export type JavaAgentSession = Omit<
  Schemas['WebShellSession'],
  'environment'
> & {
  environment?: JavaAgentEnvironment | null;
};

export type JavaAgentSessionPage = Omit<
  Schemas['WebShellSessionPage'],
  'data'
> & {
  data: JavaAgentSession[];
};

export type JavaAgentEvent = Schemas['WebShellEvent'];

export type JavaAgentContentPart = Schemas['WebShellContentPart'];

export type JavaAgentItem = Schemas['WebShellItem'];

export type JavaAgentCommandAdmission = Schemas['WebShellAdmission'];

export type JavaAgentTranscript = Schemas['WebShellTranscript'];

// The server still accepts only "text" blocks, not the contract's "input_text"
// (contract-known-gaps.txt in packages/sdk-java/managed-agent-server).
type JavaAgentInput<T> = Omit<T, 'input'> & {
  input: Array<{ type: 'text'; text: string }>;
};

export interface JavaManagedAgentClientOptions {
  baseUrl: string;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}

export class JavaManagedAgentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JavaManagedAgentHttpError';
  }
}

const API_PREFIX = '/api/agent/web-shell/v1';

export class JavaManagedAgentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: RequestCredentials;

  constructor(private readonly options: JavaManagedAgentClientOptions) {
    const base = new URL(
      options.baseUrl,
      typeof window === 'undefined'
        ? 'http://localhost'
        : window.location.origin,
    );
    base.search = '';
    base.hash = '';
    this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.credentials ?? 'include';
  }

  listSessions(
    request: Schemas['WebShellListRequest'],
    signal?: AbortSignal,
  ): Promise<JavaAgentSessionPage> {
    return this.post('/sessions/query', request, signal);
  }

  getSession(sessionId: string, signal?: AbortSignal) {
    return this.post<JavaAgentSession>('/sessions/get', { sessionId }, signal);
  }

  getTranscript(
    request: Schemas['WebShellTranscriptRequest'],
    signal?: AbortSignal,
  ): Promise<JavaAgentTranscript> {
    return this.post('/transcript/query', request, signal);
  }

  createSession(
    request: JavaAgentInput<Schemas['WebShellCreateRequest']>,
    signal?: AbortSignal,
  ): Promise<JavaAgentCommandAdmission> {
    return this.post('/sessions/create', request, signal);
  }

  submitTurn(
    request: JavaAgentInput<Schemas['WebShellSubmitRequest']>,
    signal?: AbortSignal,
  ): Promise<JavaAgentCommandAdmission> {
    return this.post('/turns/submit', request, signal);
  }

  cancelTurn(
    request: Schemas['WebShellCancelRequest'],
    signal?: AbortSignal,
  ): Promise<JavaAgentCommandAdmission> {
    return this.post('/turns/cancel', request, signal);
  }

  async *streamEvents(
    request: Schemas['WebShellStreamRequest'],
    signal?: AbortSignal,
  ): AsyncGenerator<JavaAgentEvent> {
    const response = await this.request(
      '/events/stream',
      request,
      signal,
      true,
    );
    if (!response.body) {
      throw new JavaManagedAgentHttpError(
        response.status,
        'agent_api_stream_unavailable',
        'Managed Agent event stream is unavailable',
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        let boundary = nextFrameBoundary(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const event = decodeEventFrame(frame);
          if (event) yield event;
          boundary = nextFrameBoundary(buffer);
        }
        if (result.done) break;
      }
      const event = decodeEventFrame(buffer);
      if (event) yield event;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(path, body, signal, false);
    return (await response.json()) as T;
  }

  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    stream: boolean,
  ): Promise<Response> {
    const supplied = await this.options.getHeaders?.();
    const headers = new Headers(supplied);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    headers.set('accept', stream ? 'text/event-stream' : 'application/json');
    const response = await this.fetchImpl(
      `${this.baseUrl}${API_PREFIX}${path}`,
      {
        method: 'POST',
        headers,
        credentials: this.credentials,
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      throw await toHttpError(response);
    }
    return response;
  }
}

function nextFrameBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match?.index === undefined
    ? undefined
    : { index: match.index, length: match[0].length };
}

function decodeEventFrame(frame: string): JavaAgentEvent | undefined {
  const data: string[] = [];
  let id: number | undefined;
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value =
      separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    if (field === 'id' && /^\d+$/.test(value)) id = Number(value);
  }
  if (data.length === 0) return undefined;
  const parsed: unknown = JSON.parse(data.join('\n'));
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const event = parsed as JavaAgentEvent;
  return id === undefined || event.sequence === id
    ? event
    : { ...event, sequence: id };
}

async function toHttpError(
  response: Response,
): Promise<JavaManagedAgentHttpError> {
  let code = `http_${response.status}`;
  let message = `Managed Agent request failed (${response.status})`;
  try {
    const payload: unknown = await response.json();
    if (typeof payload === 'object' && payload !== null) {
      const error = (payload as Record<string, unknown>)['error'];
      if (typeof error === 'object' && error !== null) {
        const fields = error as Record<string, unknown>;
        if (typeof fields['code'] === 'string') code = fields['code'];
        if (typeof fields['message'] === 'string') message = fields['message'];
      }
    }
  } catch {
    // Preserve the stable HTTP fallback when the response is not JSON.
  }
  return new JavaManagedAgentHttpError(response.status, code, message);
}
