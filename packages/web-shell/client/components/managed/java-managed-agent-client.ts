import type { components } from './generated/managed-agent-api';
import type {
  ManagedArtifact,
  ManagedArtifactPage,
  ManagedArtifactResponse,
  ManagedToolResultResponse,
} from './managed-tool-result-types';

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

export type JavaAgentWorkspace = Schemas['WebShellWorkspace'];

export type JavaAgentWorkspacePage = Schemas['WebShellWorkspacePage'];

export type JavaAgentSessionPage = Omit<
  Schemas['WebShellSessionPage'],
  'data'
> & {
  data: JavaAgentSession[];
};

export type JavaAgentEvent = Schemas['WebShellEvent'];

export type JavaAgentResyncRequired = Schemas['WebShellResyncRequired'];

const RESYNC_REQUIRED = 'agent.session.resync_required';

// Corrupt frames tolerated in a row before the stream resyncs past the
// poisoned run. Only a decoded event resets the count: heartbeats must not
// dilute a stream that serves nothing but corrupt frames.
const MAX_CONSECUTIVE_CORRUPT_FRAMES = 3;
// Skip warnings are rate-limited per connection: the first carries the frame
// identity, and alternating corruption would otherwise log at stream rate.
const SKIP_LOG_EVERY = 50;

// The only corrupt frames a skip can survive: delta text the durable
// snapshot re-assembles. Anything else resyncs — a lost approval update
// leaves the Hosted approval unreachable, a lost turn terminal leaves the
// last message streaming forever, a lost turn.accepted drops the user's own
// prompt, a lost stream.reconciled keeps retracted text on screen, and an
// unknown name is by definition one the panel has not budgeted for.
export const SKIP_ON_CORRUPT: ReadonlySet<string> = new Set([
  'item.output_text.delta',
  'item.reasoning.delta',
]);

export function isJavaAgentResyncRequired(
  frame: JavaAgentEvent | JavaAgentResyncRequired,
): frame is JavaAgentResyncRequired {
  return frame.type === RESYNC_REQUIRED && !('sequence' in frame);
}

export type JavaAgentContentPart = Schemas['WebShellContentPart'];

export type JavaAgentItem = Schemas['WebShellItem'];

export type JavaAgentCommandAdmission = Schemas['WebShellAdmission'];

export type JavaAgentTranscript = Schemas['WebShellTranscript'];
export type JavaAgentAction = Schemas['WebShellAction'];
export type JavaAgentActionPage = Schemas['WebShellActionPage'];

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

  listWorkspaces(
    request: Schemas['WebShellWorkspaceQueryRequest'],
    signal?: AbortSignal,
  ): Promise<JavaAgentWorkspacePage> {
    return this.post('/workspaces/query', request, signal);
  }

  getWorkspace(workspaceId: string, signal?: AbortSignal) {
    return this.post<JavaAgentWorkspace>(
      '/workspaces/get',
      { workspaceId },
      signal,
    );
  }

  getTranscript(
    request: Schemas['WebShellTranscriptRequest'],
    signal?: AbortSignal,
  ): Promise<JavaAgentTranscript> {
    return this.post('/transcript/query', request, signal);
  }

  createSession(
    request: Schemas['WebShellCreateRequest'],
    signal?: AbortSignal,
  ): Promise<JavaAgentCommandAdmission> {
    return this.post('/sessions/create', request, signal);
  }

  submitTurn(
    request: Schemas['WebShellSubmitRequest'],
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

  queryActions(
    request: Schemas['WebShellActionQueryRequest'],
    signal?: AbortSignal,
  ): Promise<JavaAgentActionPage> {
    return this.post('/actions/query', request, signal);
  }

  respondAction(
    request: Schemas['WebShellActionRespondRequest'],
    signal?: AbortSignal,
  ): Promise<Schemas['WebShellCommandOperation']> {
    return this.post('/actions/respond', request, signal);
  }

  getToolResult(sessionId: string, itemId: string, signal?: AbortSignal) {
    return this.post<ManagedToolResultResponse>(
      '/tool-results/get',
      { sessionId, itemId },
      signal,
    );
  }

  listArtifacts(
    request: { sessionId: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ) {
    return this.post<ManagedArtifactPage>('/artifacts/query', request, signal);
  }

  getArtifact(sessionId: string, artifactId: string, signal?: AbortSignal) {
    return this.post<ManagedArtifactResponse>(
      '/artifacts/get',
      { sessionId, artifactId },
      signal,
    );
  }

  async readArtifactRange(
    artifact: ManagedArtifact,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      length > 1024 * 1024 ||
      offset >= artifact.byte_length
    ) {
      throw new Error('Invalid artifact byte range');
    }
    const end = Math.min(offset + length, artifact.byte_length) - 1;
    const response = await this.artifactContent(
      artifact,
      signal,
      `bytes=${offset}-${end}`,
    );
    if (
      response.status !== 206 ||
      response.headers.get('content-range') !==
        `bytes ${offset}-${end}/${artifact.byte_length}`
    ) {
      await response.body?.cancel();
      throw new Error('Artifact response does not match the requested range');
    }
    const bytes = new Uint8Array(end - offset + 1);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Artifact response has no byte stream');
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (received + chunk.value.byteLength > bytes.byteLength) {
          throw new Error('Artifact response exceeds the requested range');
        }
        bytes.set(chunk.value, received);
        received += chunk.value.byteLength;
      }
      if (received !== bytes.byteLength) {
        throw new Error('Artifact response ended before the requested range');
      }
      return bytes;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async openArtifactStream(
    artifact: ManagedArtifact,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.artifactContent(artifact, signal);
    if (
      response.status !== 200 ||
      response.headers.get('content-length') !== String(artifact.byte_length) ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error('Artifact download does not match its metadata');
    }
    let received = 0;
    return response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > artifact.byte_length) {
            throw new Error('Artifact download exceeds its declared length');
          }
          controller.enqueue(chunk);
        },
        flush() {
          if (received !== artifact.byte_length) {
            throw new Error('Artifact download is incomplete');
          }
        },
      }),
      { signal },
    );
  }

  private async artifactContent(
    artifact: ManagedArtifact,
    signal?: AbortSignal,
    range?: string,
  ): Promise<Response> {
    if (
      !/^[a-f0-9]{64}$/.test(artifact.revision) ||
      artifact.sha256 !== artifact.revision ||
      !Number.isSafeInteger(artifact.byte_length) ||
      artifact.byte_length < 0
    ) {
      throw new Error('Artifact byte identity is invalid');
    }
    const headers = new Headers(await this.options.getHeaders?.());
    headers.set('accept', 'application/octet-stream');
    headers.set('if-match', `"${artifact.sha256}"`);
    if (range) headers.set('range', range);
    const path = `/v1/agents/sessions/${encodeURIComponent(artifact.session_id)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await this.fetchImpl(
        `${this.baseUrl}${path}?revision=${encodeURIComponent(artifact.revision)}`,
        {
          method: 'GET',
          headers,
          credentials: this.credentials,
          signal,
          redirect: 'error',
        },
      );
      if (attempt > 0 || ![429, 503].includes(response.status)) break;
      const retryAfter = response.headers.get('retry-after');
      const delay =
        retryAfter === null
          ? 1000
          : Number.isFinite(Number(retryAfter))
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now();
      const wait = Number.isFinite(delay) ? Math.max(0, delay) : 1000;
      if (wait > 5000) break;
      await response.body?.cancel();
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, wait);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (!response.ok) throw await toHttpError(response);
    if (
      response.headers.get('etag') !== `"${artifact.sha256}"` ||
      ![null, 'identity'].includes(response.headers.get('content-encoding'))
    ) {
      await response.body?.cancel();
      throw new Error('Artifact validator does not match its metadata');
    }
    return response;
  }

  async *streamEvents(
    request: Schemas['WebShellStreamRequest'],
    signal?: AbortSignal,
  ): AsyncGenerator<JavaAgentEvent | JavaAgentResyncRequired> {
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
    let consecutiveCorrupt = 0;
    let skippedTotal = 0;
    let yieldedAny = false;
    // The fields are informational and never read, hence the placeholders.
    const resyncFrame = (): JavaAgentResyncRequired => ({
      type: RESYNC_REQUIRED,
      sessionId: request.sessionId,
      replayFloorSequence: 0,
      snapshotThroughSequence: 0,
      action: 'reload_snapshot',
    });
    const decodeFrame = (
      frame: string,
      trailing = false,
    ): JavaAgentEvent | JavaAgentResyncRequired | undefined => {
      let event: JavaAgentEvent | JavaAgentResyncRequired | undefined;
      let failure: unknown;
      try {
        event = decodeEventFrame(frame);
      } catch (error) {
        failure = error;
      }
      if (event) {
        consecutiveCorrupt = 0;
        return event;
      }
      const { data, id, name } = parseEventFrameFields(frame);
      if (data.length === 0) {
        const hasContent = frame
          .split(/\r?\n/)
          .some((line) => line && !line.startsWith(':'));
        if (!hasContent) return undefined; // heartbeat or comment
        if (!trailing) {
          // A mid-stream frame with id/event lines but no data line is
          // malformed server output, not a heartbeat: count it as corrupt
          // below instead of dropping it silently.
          failure ??= new Error('frame has no data payload');
        }
      }
      if (trailing) {
        // A leftover buffer at end of stream is a mid-frame disconnect, not
        // a corrupt persisted frame: log it as such and spare the budget.
        console.warn(
          `[web-shell] the Managed Agent event stream closed mid-frame; the frame at id ${id ?? 'none'} was discarded`,
        );
        return undefined;
      }
      // Corrupt frame: unparseable JSON, a payload that is not an event
      // object, or a mid-stream frame with no data line. Skip it and let
      // later frames move the consumer's cursor past it — except the shapes
      // a skip cannot recover from, which resync.
      consecutiveCorrupt += 1;
      if (
        // A run of corrupt frames means the log itself is poisoned: resync
        // past the whole run instead of skipping forever. (The id-less
        // resync marker is covered by the fail-closed rule too.)
        consecutiveCorrupt > MAX_CONSECUTIVE_CORRUPT_FRAMES ||
        // Fail closed: only delta text the snapshot re-assembles may skip.
        !SKIP_ON_CORRUPT.has(name ?? '')
      ) {
        console.warn(
          `[web-shell] resyncing on a corrupt Managed Agent frame (id: ${id ?? 'none'}, event: ${name ?? 'unknown'}):`,
          failure ?? 'non-event payload',
        );
        consecutiveCorrupt = 0;
        return resyncFrame();
      }
      skippedTotal += 1;
      if (skippedTotal === 1 || skippedTotal % SKIP_LOG_EVERY === 0) {
        console.warn(
          `[web-shell] skipping a corrupt Managed Agent event frame (id: ${id ?? 'none'}, event: ${name ?? 'unknown'}):`,
          failure ?? 'non-event payload',
        );
      }
      return undefined;
    };
    try {
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        let boundary = nextFrameBoundary(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const event = decodeFrame(frame);
          if (event) {
            yieldedAny = true;
            yield event;
          }
          boundary = nextFrameBoundary(buffer);
        }
        if (result.done) break;
      }
      const event = decodeFrame(buffer, true);
      if (event) {
        yieldedAny = true;
        yield event;
      }
      // A connection that delivered nothing but skips means the rest of the
      // replay log is undeliverable: end with a resync so the consumer
      // reloads the durable transcript instead of retrying the same cursor.
      if (!yieldedAny && skippedTotal > 0) {
        console.warn(
          `[web-shell] resyncing a Managed Agent stream that delivered only corrupt frames (${skippedTotal} skipped)`,
        );
        yield resyncFrame();
      }
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

function parseEventFrameFields(frame: string): {
  data: string[];
  id?: number;
  name?: string;
} {
  const data: string[] = [];
  let id: number | undefined;
  let name: string | undefined;
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value =
      separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    if (field === 'id' && /^\d+$/.test(value)) id = Number(value);
    if (field === 'event') name = value;
  }
  return { data, id, name };
}

function decodeEventFrame(
  frame: string,
): JavaAgentEvent | JavaAgentResyncRequired | undefined {
  const { data, id, name } = parseEventFrameFields(frame);
  if (data.length === 0) return undefined;
  const parsed: unknown = JSON.parse(data.join('\n'));
  // Both frame shapes this stream carries are objects with a string `type`
  // (WebShellEvent and WebShellResyncRequired); anything else is corrupt.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  )
    return undefined;
  // The server's only frame without an id: the cursor fell below the replay
  // floor, and the stream ends after it.
  if (name === RESYNC_REQUIRED && id === undefined) {
    return parsed as JavaAgentResyncRequired;
  }
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
