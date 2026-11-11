/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CustomRequest } from '../../../client/request/customRequest.js';
import type { CustomResponse } from '../../../client/response/customResponse.js';
import type { Transport } from '../../../client/transport/transport.js';
import {
  getI18nService,
  initializeI18nService,
  resetI18nService,
} from '../../../i18n/index.js';
import { runLogger } from '../../../utils/runLogger.js';
import { QoderCredentialStore } from '../credential-store.js';
import { QoderOAuthError } from '../oauth-client.js';
import { QODER_ENV_GATEWAY_BASE_URL } from '../regions.js';
import { QoderInferenceError } from './api/inference/inference.js';
import type { QoderTokenProvider } from './pipeline/valve/authValve.js';
import { createQoderClient } from './qoderClientFactory.js';

const ENV = {
  [QODER_ENV_GATEWAY_BASE_URL]: 'https://gateway.test',
};

let tempDir: string;
let store: QoderCredentialStore;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-client-'));
  store = new QoderCredentialStore({
    filePath: path.join(tempDir, 'qoder_oauth_creds.json'),
  });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

class RecordingTransport implements Transport {
  readonly requests: CustomRequest[] = [];
  private readonly responses: Array<Response | Error>;

  constructor(...responses: Array<Response | Error>) {
    this.responses = [...responses];
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    this.requests.push(input);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error('RecordingTransport: no response queued');
    }
    if (next instanceof Error) throw next;
    output.raw = next;
  }
}

function sseResponse(events: unknown[]): Response {
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(`${payload}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function responsesBody(
  overrides: Partial<ResponseCreateParamsStreaming> = {},
): ResponseCreateParamsStreaming {
  return {
    model: 'auto',
    input: 'hello',
    stream: true,
    ...overrides,
  } as ResponseCreateParamsStreaming;
}

function continuationBody(
  overrides: Partial<ResponseCreateParamsStreaming> = {},
): ResponseCreateParamsStreaming {
  return responsesBody({
    input: [
      { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
    ],
    ...overrides,
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sequenceIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}

function createClient(
  transport: RecordingTransport,
  tokenProvider: QoderTokenProvider = {
    getAccessToken: async () => 'token',
  },
) {
  return createQoderClient({
    region: 'global',
    env: ENV,
    credentialStore: store,
    tokenProvider,
    clientVersion: '1.0.0',
    generateId: sequenceIds(),
    transport,
  });
}

describe('QoderClient', () => {
  it('lists the qcode catalog through the outbound pipeline', async () => {
    const transport = new RecordingTransport(
      jsonResponse({ qcode: [{ key: 'auto', display_name: 'Auto' }] }),
    );
    const client = createClient(transport);

    const models = await client.api.models.list();

    expect(models.map((model) => model.key)).toEqual(['auto']);
    const [request] = transport.requests;
    expect(request.url).toBe(
      'https://gateway.test/api/v3/model/list?categories=qcode',
    );
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer token',
      'Cosy-ClientType': '13',
      'Cosy-Version': '1.0.0',
      'X-Request-Id': 'id-1',
    });
  });

  it('includes the request id when the catalog request fails', async () => {
    const transport = new RecordingTransport(
      new Response('', { status: 404 }),
    );
    const client = createClient(transport);

    await expect(client.api.models.list()).rejects.toThrow(
      /requestId=id-1/,
    );
  });

  it('streams inference with attribution headers and a pruned body', async () => {
    const transport = new RecordingTransport(
      sseResponse([
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: 'hi' },
      ]),
    );
    const client = createClient(transport);

    const events = await collect(
      client.api.inference.stream(
        {
          body: responsesBody({
            temperature: 0.5,
            top_p: 0.9,
            prompt_cache_key: 'cache',
            truncation: 'auto',
            tools: [
              {
                type: 'function',
                name: 'read_file',
                parameters: { type: 'object', properties: {} },
                strict: false,
              },
            ],
          }),
          business: {
            id: 'business-1',
            type: 'code_review',
            sub_task: 'agent_sub_search',
            model_key: 'qmodel_38max',
          },
          sessionId: 'session-1',
          sourceSessionId: 'parent-session',
          requestSetId: 'turn-1',
          taskId: 'agent_summary',
        },
        { sessionId: 'session-1', requestSetId: 'turn-1' },
      ),
    );

    expect(events).toEqual([
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'hi' },
    ]);

    const [request] = transport.requests;
    expect(request.url).toBe(
      'https://gateway.test/api/v1/responses?AgentId=agent_common',
    );
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer token',
      Accept: 'text/event-stream',
      'Cosy-ClientType': '13',
      'Cosy-Version': '1.0.0',
      'X-Request-Id': 'id-1',
      'X-Session-Id': 'session-1',
      'X-Request-Set-Id': 'turn-1',
    });

    const sent = JSON.parse(String(request.body));
    expect(sent).toMatchObject({
      model: 'auto',
      stream: true,
      store: false,
      metadata: {
        session_type: 'qcode',
        task_id: 'agent_summary',
        source_session_id: 'parent-session',
        business_id: 'business-1',
        business_type: 'code_review',
        sub_task: 'agent_sub_search',
        model_key: 'qmodel_38max',
      },
    });
    expect(sent).not.toHaveProperty('parallel_tool_calls');
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).not.toHaveProperty('task_id');
    expect(sent).not.toHaveProperty('source_session_id');
    expect(sent).not.toHaveProperty('top_p');
    expect(sent).not.toHaveProperty('prompt_cache_key');
    expect(sent).not.toHaveProperty('truncation');
  });

  it('refreshes the token and retries once on HTTP 401', async () => {
    const transport = new RecordingTransport(
      new Response('token expired', { status: 401 }),
      sseResponse([{ type: 'response.completed' }]),
    );
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');
    const client = createClient(transport, { getAccessToken });

    const events = await collect(
      client.api.inference.stream({
        body: responsesBody(),
        sessionId: 'session-1',
        requestSetId: 'turn-1',
      }),
    );

    expect(events).toEqual([{ type: 'response.completed' }]);
    expect(getAccessToken).toHaveBeenNthCalledWith(1);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
    });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1].headers).toMatchObject({
      Authorization: 'Bearer fresh-token',
      'X-Request-Id': 'id-2',
    });
  });

  it('surfaces a repeated 401 after the refresh retry', async () => {
    const transport = new RecordingTransport(
      new Response('token expired', { status: 401 }),
      new Response('still expired', { status: 401 }),
    );
    const client = createClient(transport);

    await expect(
      collect(client.api.inference.stream({ body: responsesBody() })),
    ).rejects.toMatchObject({
      name: 'QoderInferenceError',
      status: 401,
      responseBody: 'still expired',
    });
  });

  it('includes the request id and response body in inference failures', async () => {
    const transport = new RecordingTransport(
      new Response('bad request body', { status: 400 }),
    );
    const client = createClient(transport);

    let error: unknown;
    try {
      await collect(client.api.inference.stream({ body: responsesBody() }));
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: 'QoderInferenceError',
      status: 400,
    });
    expect((error as QoderInferenceError).requestId).toMatch(/^id-\d+$/);
    expect(String((error as Error).message)).toMatch(
      /requestId=id-\d+.*bad request body/,
    );
  });

  it('exposes the Responses API for the shared transport', async () => {
    const transport = new RecordingTransport(
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);

    const events = await collect(
      client.api.inference.responses.stream({
        model: 'auto',
        input: 'hello',
        stream: true,
      }),
    );

    expect(events).toEqual([{ type: 'response.completed' }]);
    expect(transport.requests[0].url).toBe(
      'https://gateway.test/api/v1/responses?AgentId=agent_common',
    );
  });

  it('does not send x-gw identity headers', async () => {
    const transport = new RecordingTransport(
      jsonResponse({ qcode: [] }),
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createQoderClient({
      region: 'global',
      env: ENV,
      credentialStore: store,
      tokenProvider: { getAccessToken: async () => 'token' },
      gatewayBaseUrl: 'https://gateway.test/qsvr',
      clientVersion: '1.0.0',
      generateId: sequenceIds(),
      transport,
    });

    await client.api.models.list();
    await collect(
      client.api.inference.stream({
        body: responsesBody(),
        sessionId: 'session-1',
        requestSetId: 'turn-1',
      }),
    );

    for (const request of transport.requests) {
      expect(request.headers).not.toHaveProperty('x-gw-user-id');
      expect(request.headers).not.toHaveProperty('x-gw-org-id');
      expect(request.headers).not.toHaveProperty('x-gw-user-type');
      expect(request.headers).not.toHaveProperty('x-data-policy-agreed');
    }
    expect(transport.requests[0].url).toBe(
      'https://gateway.test/qsvr/api/v3/model/list?categories=qcode',
    );
    expect(transport.requests[1].url).toBe(
      'https://gateway.test/qsvr/api/v1/responses?AgentId=agent_common',
    );
  });

  it('rejects protocols the Qoder gateway does not serve', () => {
    const client = createClient(new RecordingTransport());

    expect(() =>
      client.api.inference.chatCompletions.stream({} as never),
    ).toThrow(QoderInferenceError);
    expect(() => client.api.inference.messages.stream({} as never)).toThrow(
      QoderInferenceError,
    );
  });

  it('rejects a login-gated request before sending without an account', async () => {
    const transport = new RecordingTransport(jsonResponse({ qcode: [] }));
    const client = createClient(transport, {
      getAccessToken: async () => {
        throw new QoderOAuthError('invalid_grant', 'sign-in required');
      },
    });

    await expect(client.api.models.list()).rejects.toMatchObject({
      code: 'auth_required',
    });
    expect(transport.requests).toHaveLength(0);
  });
  it('adds the header to the next user request and clears it on success', async () => {
    const rejection = jsonResponse(
      {
        code: '145',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
        message: 'quota exhausted',
        modelKey: 'dfmodel',
        confirmationExpiresAt: Date.now() + 60_000,
      },
      403,
    );
    const transport = new RecordingTransport(
      rejection,
      sseResponse([{ type: 'response.completed' }]),
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);
    const body = responsesBody({ model: 'dfmodel' });

    await expect(
      collect(
        client.api.inference.stream({
          body,
          requestSetId: 'turn-1',
          business: { id: 'turn-1', type: 'agent' },
        }),
      ),
    ).rejects.toThrow(/complimentary credits/);
    await collect(
      client.api.inference.stream({
        body,
        requestSetId: 'turn-2',
        business: { id: 'turn-2', type: 'agent' },
      }),
    );
    await collect(
      client.api.inference.stream({
        body,
        requestSetId: 'turn-3',
        business: { id: 'turn-3', type: 'agent' },
      }),
    );

    expect(transport.requests[0].headers).not.toHaveProperty(
      'Cosy-Paid-Confirmed',
    );
    expect(transport.requests[1].headers).toHaveProperty(
      'Cosy-Paid-Confirmed',
      'true',
    );
    expect(transport.requests[2].headers).not.toHaveProperty(
      'Cosy-Paid-Confirmed',
    );
  });

  it('logs request headers with credentials redacted', async () => {
    const rejection = jsonResponse(
      {
        code: '145',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
        modelKey: 'dfmodel',
      },
      403,
    );
    const transport = new RecordingTransport(
      rejection,
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);
    const body = responsesBody({ model: 'dfmodel' });
    const debug = vi.spyOn(runLogger, 'debug');

    try {
      await expect(
        collect(
          client.api.inference.stream({
            body,
            requestSetId: 'turn-1',
            business: { id: 'turn-1', type: 'agent' },
          }),
        ),
      ).rejects.toThrow(/complimentary credits/);
      await collect(
        client.api.inference.stream({
          body,
          requestSetId: 'turn-2',
          business: { id: 'turn-2', type: 'agent' },
        }),
      );

      const headerLogs = debug.mock.calls
        .filter(([message]) => message === '[qoder-inference] request headers')
        .map(([, entry]) => entry as { headers: Record<string, string> });

      expect(headerLogs).toHaveLength(2);
      expect(headerLogs[0].headers).not.toHaveProperty('Cosy-Paid-Confirmed');
      expect(headerLogs[1].headers).toHaveProperty(
        'Cosy-Paid-Confirmed',
        'true',
      );
      expect(headerLogs[1].headers).toHaveProperty(
        'Authorization',
        '[redacted]',
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('does not add the header to a tool continuation', async () => {
    const rejection = jsonResponse(
      {
        code: '145',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
        modelKey: 'dfmodel',
      },
      403,
    );
    const otherFailure = jsonResponse(
      { code: '998', message: 'request denied' },
      403,
    );
    const transport = new RecordingTransport(
      rejection,
      otherFailure,
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);
    const body = responsesBody({ model: 'dfmodel' });

    await expect(
      collect(
        client.api.inference.stream({
          body,
          requestSetId: 'turn-1',
          business: { id: 'turn-1', type: 'agent' },
        }),
      ),
    ).rejects.toThrow(/complimentary credits/);
    await expect(
      collect(
        client.api.inference.stream({
          body: continuationBody({ model: 'dfmodel' }),
          requestSetId: 'turn-1',
          business: { id: 'turn-1', type: 'agent' },
        }),
      ),
    ).rejects.toMatchObject({ code: '998' });
    await collect(
      client.api.inference.stream({
        body,
        requestSetId: 'turn-2',
        business: { id: 'turn-2', type: 'agent' },
      }),
    );

    expect(transport.requests[1].headers).not.toHaveProperty(
      'Cosy-Paid-Confirmed',
    );
    expect(transport.requests[2].headers).toHaveProperty(
      'Cosy-Paid-Confirmed',
      'true',
    );
  });

  it('does not arm confirmation for old paid error codes', async () => {
    const rejection = jsonResponse(
      {
        code: '140',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
        modelKey: 'dfmodel',
      },
      403,
    );
    const transport = new RecordingTransport(
      rejection,
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);
    const body = responsesBody({ model: 'dfmodel' });

    await expect(
      collect(
        client.api.inference.stream({
          body,
          requestSetId: 'turn-1',
          business: { id: 'turn-1', type: 'agent' },
        }),
      ),
    ).rejects.toThrow(/免费额度/);
    await collect(
      client.api.inference.stream({
        body,
        requestSetId: 'turn-2',
        business: { id: 'turn-2', type: 'agent' },
      }),
    );

    expect(transport.requests[1].headers).not.toHaveProperty(
      'Cosy-Paid-Confirmed',
    );
  });
  it('localizes the paid confirmation message for the UI locale', async () => {
    initializeI18nService();
    try {
      getI18nService().configureUi({
        locale: 'zh-CN',
        preference: 'zh-CN',
        dynamicContentEnabled: true,
      });
      const transport = new RecordingTransport(
        jsonResponse(
          {
            code: '145',
            subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
            modelKey: 'dfmodel',
          },
          403,
        ),
      );
      const client = createClient(transport);

      await expect(
        collect(
          client.api.inference.stream({
            body: responsesBody({ model: 'dfmodel' }),
            requestSetId: 'turn-1',
            }),
        ),
      ).rejects.toThrow(
        '赠送的免费额度已用尽，回答已暂停。继续回答将消耗您的付费额度。',
      );
    } finally {
      resetI18nService();
    }
  });

  it('does not arm confirmation for background model calls', async () => {
    const rejection = jsonResponse(
      {
        code: '147',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
        modelKey: 'dfmodel',
        confirmationExpiresAt: Date.now() + 60_000,
      },
      403,
    );
    const transport = new RecordingTransport(
      rejection,
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);
    const body = responsesBody({ model: 'dfmodel' });

    await expect(
      collect(
        client.api.inference.stream({
          body,
          requestSetId: 'turn-1',
          business: {
            id: 'biz',
            type: 'agent',
            sub_task: 'title_generation',
          },
        }),
      ),
    ).rejects.toThrow(/complimentary credits/);
    await collect(
      client.api.inference.stream({
        body,
        requestSetId: 'turn-2',
        business: { id: 'turn-2', type: 'agent' },
      }),
    );

    expect(transport.requests[1].headers).not.toHaveProperty(
      'Cosy-Paid-Confirmed',
    );
  });

  it('keeps confirmation armed until a successful inference', async () => {
    const rejection = jsonResponse(
      {
        code: '145',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
        modelKey: 'dfmodel',
      },
      403,
    );
    const transientFailure = jsonResponse(
      { code: '999', message: 'request denied' },
      403,
    );
    const transport = new RecordingTransport(
      rejection,
      transientFailure,
      sseResponse([{ type: 'response.completed' }]),
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);
    const body = responsesBody({ model: 'dfmodel' });
    const userTurn = (requestSetId: string) => ({
      body,
      requestSetId,
      business: { id: requestSetId, type: 'agent' },
    });

    await expect(
      collect(client.api.inference.stream(userTurn('turn-1'))),
    ).rejects.toThrow(/complimentary credits/);
    await expect(
      collect(client.api.inference.stream(userTurn('turn-2'))),
    ).rejects.toMatchObject({ code: '999' });
    await collect(client.api.inference.stream(userTurn('turn-3')));
    await collect(client.api.inference.stream(userTurn('turn-4')));

    expect(transport.requests[1].headers).toHaveProperty(
      'Cosy-Paid-Confirmed',
      'true',
    );
    expect(transport.requests[2].headers).toHaveProperty(
      'Cosy-Paid-Confirmed',
      'true',
    );
    expect(transport.requests[3].headers).not.toHaveProperty(
      'Cosy-Paid-Confirmed',
    );
  });

  it('clears paid confirmation after any successful inference', async () => {
    const rejection = jsonResponse(
      {
        code: '145',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
        modelKey: 'dfmodel',
      },
      403,
    );
    const transport = new RecordingTransport(
      rejection,
      sseResponse([{ type: 'response.completed' }]),
      sseResponse([{ type: 'response.completed' }]),
    );
    const client = createClient(transport);
    const body = responsesBody({ model: 'dfmodel' });

    await expect(
      collect(
        client.api.inference.stream({
          body,
          requestSetId: 'turn-1',
          business: { id: 'turn-1', type: 'agent' },
        }),
      ),
    ).rejects.toThrow(/complimentary credits/);
    await collect(
      client.api.inference.stream({
        body,
        requestSetId: 'subagent-1',
        business: {
          id: 'turn-1',
          type: 'agent',
          sub_task: 'agent_sub_general_purpose',
        },
      }),
    );
    await collect(
      client.api.inference.stream({
        body,
        requestSetId: 'turn-2',
        business: { id: 'turn-2', type: 'agent' },
      }),
    );

    expect(transport.requests[1].headers).toHaveProperty(
      'Cosy-Paid-Confirmed',
      'true',
    );
    expect(transport.requests[2].headers).not.toHaveProperty(
      'Cosy-Paid-Confirmed',
    );
  });
});
