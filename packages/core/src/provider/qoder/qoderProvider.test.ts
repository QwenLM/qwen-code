/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SettingsService } from '@qwen-code/resource';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomRequest } from '../../client/request/customRequest.js';
import type { CustomResponse } from '../../client/response/customResponse.js';
import type { Transport } from '../../client/transport/transport.js';
import {
  getI18nService,
  initializeI18nService,
  resetI18nService,
} from '../../i18n/index.js';
import { QoderCredentialStore } from '../../qoder/api/credential-store.js';
import { createQoderClient } from '../../qoder/api/client/qoderClientFactory.js';
import type { QoderTokenProvider } from '../../qoder/api/client/pipeline/valve/authValve.js';
import { formatApiErrorDisplayMessage } from '../../utils/errorParsing.js';
import { resolveErrorPresentation } from '../../utils/errorPresentation.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import { ModelProviderManager } from '../impl/modelProviderManager.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import { ResponsesTransport } from '../transport/impl/responsesTransport.js';
import { QoderProvider } from './qoderProvider.js';
import type { QoderModelStreamRequest } from './qoderModelStreamRequest.js';

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  logicalRequestId?: string;
}
type Reply = () => Response | Promise<Response>;

/** Only the physical network is replaced; provider, codecs, API and valves are real. */
class RecordingTransport implements Transport {
  readonly sends: SentRequest[] = [];
  readonly replies: Reply[] = [];

  async invoke(
    request: CustomRequest,
    response: CustomResponse,
  ): Promise<void> {
    if (request.url.includes('/model/list')) {
      response.raw = new Response(
        JSON.stringify({
          qcode: [
            {
              key: 'auto',
              display_name: 'Auto',
              enable: true,
              is_default: true,
              context_config: {
                '200k': { token_count: 200000, is_default: true },
              },
            },
          ],
        }),
      );
      return;
    }
    this.sends.push({
      url: request.url,
      headers: { ...request.headers },
      body: JSON.parse(String(request.body)) as Record<string, unknown>,
      logicalRequestId: request.requestId,
    });
    const reply = this.replies.shift();
    if (!reply) throw new Error('No synthetic response queued');
    response.raw = await reply();
  }
}
function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}
function complete(tool = false): Response {
  const item = tool
    ? {
        id: 'fc-item',
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{}',
      }
    : {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
      };
  const response = {
    id: 'resp-1',
    model: 'auto',
    status: 'completed',
    output: [item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  return sse([
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]);
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function setup(
  tokens: QoderTokenProvider = {
    getAccessToken: async () => 'synthetic-token',
  },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-attribution-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new QoderCredentialStore({
    filePath: path.join(dir, 'credentials.json'),
  });
  await store.upsert({
    region: 'global',
    userId: 'synthetic-user',
    userName: 'Synthetic',
    accessToken: 'synthetic-token',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3600000,
  });
  const wire = new RecordingTransport();
  let physicalId = 0;
  const gatewayBaseUrl = 'https://synthetic.invalid';
  const client = createQoderClient({
    region: 'global',
    gatewayBaseUrl,
    credentialStore: store,
    tokenProvider: tokens,
    transport: wire,
    generateId: () => `wire-${++physicalId}`,
  });
  const provider = new QoderProvider({
    client,
    gatewayBaseUrl,
    settingsService: new SettingsService(),
  });
  cleanups.push(() => provider.stop());
  await provider.start();
  const model = await provider.getModel('auto');
  if (!model) throw new Error('Synthetic catalog did not load');
  const resolution = await provider.select({
    purpose: 'main',
    mainModel: model,
  });
  function request(
    sessionId = 'session-1',
    requestSetId = 'turn-1',
    businessId = requestSetId,
    type = 'agent',
  ): QoderModelStreamRequest {
    return {
      resolution,
      prompt: {
        messages: [
          { role: 'system', content: 'Synthetic instruction' },
          { role: 'user', content: 'Synthetic input' },
        ],
      },
      qoder: {
        identity: {
          sessionId,
          requestSetId,
          requestId: `logical-${requestSetId}`,
        },
        business: { id: businessId, type },
      },
    };
  }
  return { provider, wire, request, model };
}
async function drain(response: ModelStreamResponse) {
  const events = [];
  for await (const event of response.events) events.push(event);
  return { events, message: await response.completed };
}

describe('QoderProvider attribution through the real Responses API chain', () => {
  it('preserves catalog/preferences and sends selected context and actual business', async () => {
    const h = await setup();
    expect((await h.provider.listModels()).map((model) => model.key)).toEqual([
      'auto',
    ]);
    h.provider.setModelConfig(h.model, { context: { contextWindow: 100000 } });
    const resolution = await h.provider.select({
      purpose: 'main',
      mainModel: h.model,
    });
    h.wire.replies.push(() => complete());
    const { message, events } = await drain(
      await h.provider.inference({
        ...h.request('session-1', 'turn-1', 'business-1', 'code_review'),
        resolution,
      }),
    );
    expect(message.blocks).toEqual([{ type: 'text', text: 'answer' }]);
    expect(
      events.some((event) => event.type === 'content_block_complete'),
    ).toBe(true);
    expect(h.wire.sends).toHaveLength(1);
    expect(h.wire.sends[0]).toMatchObject({
      url: 'https://synthetic.invalid/api/v1/responses?AgentId=agent_common',
      logicalRequestId: 'logical-turn-1',
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Cosy-ClientType': '13',
        'X-Session-Id': 'session-1',
        'X-Request-Set-Id': 'turn-1',
      },
      body: {
        model: 'auto',
        instructions: 'Synthetic instruction',
        stream: true,
        store: false,
        metadata: {
          session_type: 'qcode',
          business_id: 'business-1',
          business_type: 'code_review',
          context_length: '100000',
        },
      },
    });
  });

  it('routes through the session manager and retains the product provider on custom refresh', async () => {
    const h = await setup();
    const manager = new ModelProviderManager({
      userProviders: [h.provider],
      modelTransportManager: new ModelTransportManager([
        new ResponsesTransport(),
      ]),
      settingsService: new SettingsService(),
    });
    cleanups.push(() => manager.stop());
    await manager.start();
    manager.setMainModel(h.model);
    await manager.replaceCustomProviders(undefined, undefined);
    const resolution = await manager.select({ purpose: 'main' });
    h.wire.replies.push(() => complete());
    const message = await (
      await manager.inference({ ...h.request(), resolution })
    ).completed;
    expect(message.blocks).toEqual([{ type: 'text', text: 'answer' }]);
    expect(h.wire.sends[0].body['metadata']).toMatchObject({
      business_id: 'turn-1',
    });
  });

  it('keeps turn/business through tool continuation and changes them for a new turn', async () => {
    const h = await setup();
    h.wire.replies.push(
      () => complete(true),
      () => complete(),
      () => complete(),
    );
    expect(
      (await (await h.provider.inference(h.request())).completed).stopReason,
    ).toBe('tool_use');
    const input = h.request();
    await (
      await h.provider.inference({
        ...input,
        prompt: {
          messages: [
            ...input.prompt.messages,
            {
              role: 'assistant' as const,
              content: '',
              toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }],
            },
            {
              role: 'tool' as const,
              toolCallId: 'call-1',
              content: 'synthetic file',
            },
          ],
        },
      })
    ).completed;
    await (
      await h.provider.inference(h.request('session-1', 'turn-2'))
    ).completed;
    expect(h.wire.sends.map((send) => send.headers['X-Session-Id'])).toEqual([
      'session-1',
      'session-1',
      'session-1',
    ]);
    expect(
      h.wire.sends.map((send) => send.headers['X-Request-Set-Id']),
    ).toEqual(['turn-1', 'turn-1', 'turn-2']);
    expect(h.wire.sends.map((send) => send.body['metadata'])).toEqual([
      expect.objectContaining({ business_id: 'turn-1' }),
      expect.objectContaining({ business_id: 'turn-1' }),
      expect.objectContaining({ business_id: 'turn-2' }),
    ]);
    expect(
      new Set(h.wire.sends.map((send) => send.headers['X-Request-Id'])).size,
    ).toBe(3);
    expect(h.wire.sends[1].body['input']).toEqual(
      expect.arrayContaining([
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'synthetic file',
        },
      ]),
    );
  });

  it('isolates concurrent snapshots from each other and later caller mutations', async () => {
    const h = await setup();
    h.wire.replies.push(
      async () => {
        await Promise.resolve();
        return complete();
      },
      () => complete(),
    );
    const a = h.request('session-a', 'turn-a', 'business-a');
    const b = h.request('session-b', 'turn-b', 'business-b', 'code_review');
    Object.assign(a.qoder!.business!, { sub_task: 'agent_sub_search' });
    Object.assign(b.qoder!.business!, { sub_task: 'title_generation' });
    Object.assign(a.qoder!.identity, { sourceSessionId: 'parent-a' });
    Object.assign(b.qoder!.identity, { sourceSessionId: 'parent-b' });
    Object.assign(a.qoder!, { taskRouting: { taskId: 'agent_summary' } });
    Object.assign(b.qoder!, { taskRouting: { taskId: 'sec_scan' } });
    const pendingA = h.provider.inference(a);
    const pendingB = h.provider.inference(b);
    Object.assign(a.qoder!.identity, {
      sessionId: 'mutated',
      sourceSessionId: 'mutated',
    });
    Object.assign(a.qoder!.taskRouting!, { taskId: 'mutated' });
    Object.assign(a.qoder!.business!, { id: 'mutated', sub_task: 'mutated' });
    await Promise.all([
      pendingA.then((response) => response.completed),
      pendingB.then((response) => response.completed),
    ]);
    expect(
      h.wire.sends.find((send) => send.headers['X-Session-Id'] === 'session-a')
        ?.body['metadata'],
    ).toMatchObject({
      business_id: 'business-a',
      business_type: 'agent',
      sub_task: 'agent_sub_search',
      task_id: 'agent_summary',
      source_session_id: 'parent-a',
    });
    expect(
      h.wire.sends.find((send) => send.headers['X-Session-Id'] === 'session-b')
        ?.body['metadata'],
    ).toMatchObject({
      business_id: 'business-b',
      business_type: 'code_review',
      sub_task: 'title_generation',
      task_id: 'sec_scan',
      source_session_id: 'parent-b',
    });
  });

  it('keeps parent business for distinct child/title execution IDs and sends attribution metadata', async () => {
    const h = await setup();
    const executions = [
      {
        turn: 'parent-turn',
        session: 'session-1',
        subTask: undefined,
        taskId: undefined,
        sourceSessionId: undefined,
      },
      {
        turn: 'child-turn',
        session: 'child-session',
        subTask: 'agent_sub_search',
        taskId: undefined,
        sourceSessionId: 'session-1',
      },
      {
        turn: 'title-execution',
        session: 'session-1',
        subTask: 'title_generation',
        taskId: 'agent_summary',
        sourceSessionId: undefined,
      },
    ];
    for (const {
      turn,
      session,
      subTask,
      taskId,
      sourceSessionId,
    } of executions) {
      h.wire.replies.push(() => complete());
      const input = h.request(session, turn, 'parent-business', 'code_review');
      Object.assign(input.qoder!.business!, {
        ...(subTask !== undefined ? { sub_task: subTask } : {}),
        model_key: 'original-model',
        name: 'synthetic business',
      });
      Object.assign(input.qoder!.identity, { sourceSessionId });
      Object.assign(input.qoder!, { taskRouting: { taskId } });
      await (
        await h.provider.inference(input)
      ).completed;
    }
    expect(
      h.wire.sends.map((send) => send.headers['X-Request-Set-Id']),
    ).toEqual(['parent-turn', 'child-turn', 'title-execution']);
    expect(h.wire.sends.map((send) => send.headers['X-Session-Id'])).toEqual([
      'session-1',
      'child-session',
      'session-1',
    ]);
    for (const [index, send] of h.wire.sends.entries())
      expect(send.body['metadata']).toEqual({
        session_type: 'qcode',
        business_id: 'parent-business',
        business_type: 'code_review',
        model_key: 'original-model',
        ...(executions[index].subTask !== undefined
          ? { sub_task: executions[index].subTask }
          : {}),
        ...(executions[index].taskId !== undefined
          ? { task_id: executions[index].taskId }
          : {}),
        ...(executions[index].sourceSessionId !== undefined
          ? { source_session_id: executions[index].sourceSessionId }
          : {}),
        context_length: '200000',
      });
  });

  it('keeps attribution through 401 refresh with a new ID for each physical send', async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('catalog-token')
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh');
    const h = await setup({ getAccessToken });
    h.wire.replies.push(
      () => new Response('expired', { status: 401 }),
      () => complete(),
    );
    const input = h.request();
    Object.assign(input.qoder!.business!, { sub_task: 'agent_sub_search' });
    Object.assign(input.qoder!.identity, { sourceSessionId: 'parent-session' });
    Object.assign(input.qoder!, { taskRouting: { taskId: 'agent_summary' } });
    await (
      await h.provider.inference(input)
    ).completed;
    expect(h.wire.sends.map((send) => send.headers['Authorization'])).toEqual([
      'Bearer stale',
      'Bearer fresh',
    ]);
    expect(getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(h.wire.sends).toHaveLength(2);
    expect(h.wire.sends[0].headers['X-Request-Id']).not.toBe(
      h.wire.sends[1].headers['X-Request-Id'],
    );
    for (const send of h.wire.sends) {
      expect(send.headers['X-Session-Id']).toBe('session-1');
      expect(send.headers['X-Request-Set-Id']).toBe('turn-1');
      expect(send.body['metadata']).toMatchObject({
        business_id: 'turn-1',
        sub_task: 'agent_sub_search',
        task_id: 'agent_summary',
        source_session_id: 'parent-session',
      });
    }
  });

  it.each([
    {
      label: 'explicit task over policy task',
      routing: { taskId: 'agent_summary', policyTaskId: 'policy-task' },
      expectedTaskId: 'agent_summary',
      sourceSessionId: 'parent-session',
    },
    {
      label: 'policy task fallback without a source session',
      routing: { policyTaskId: 'policy-task' },
      expectedTaskId: 'policy-task',
      sourceSessionId: undefined,
    },
    {
      label: 'explicit task omission with a source session',
      routing: {
        taskId: 'agent_summary',
        policyTaskId: 'policy-task',
        omitTaskId: true,
      },
      expectedTaskId: undefined,
      sourceSessionId: 'parent-session',
    },
    {
      label: 'empty routing without invented defaults',
      routing: {},
      expectedTaskId: undefined,
      sourceSessionId: undefined,
    },
    {
      label: 'source session without task routing',
      routing: undefined,
      expectedTaskId: undefined,
      sourceSessionId: 'parent-session',
    },
  ])(
    'maps $label through metadata',
    async ({ routing, expectedTaskId, sourceSessionId }) => {
      const h = await setup();
      h.wire.replies.push(() => complete());
      const input = h.request();
      Object.assign(input.qoder!, { taskRouting: routing });
      Object.assign(input.qoder!.identity, { sourceSessionId });
      await (
        await h.provider.inference(input)
      ).completed;
      const send = h.wire.sends[0];
      expect(send.body['metadata']).toEqual({
        session_type: 'qcode',
        business_id: 'turn-1',
        business_type: 'agent',
        context_length: '200000',
        ...(expectedTaskId !== undefined ? { task_id: expectedTaskId } : {}),
        ...(sourceSessionId !== undefined
          ? { source_session_id: sourceSessionId }
          : {}),
      });
      expect(send.headers['X-Session-Id']).toBe('session-1');
      expect(send.headers).not.toHaveProperty('X-Source-Session');
      expect(send.body).not.toHaveProperty('task_id');
      expect(send.body).not.toHaveProperty('source_session_id');
    },
  );

  it.each(['', 'Agent_Sub_Search'])(
    'preserves the supplied string sub_task %j without normalization',
    async (subTask) => {
      const h = await setup();
      h.wire.replies.push(() => complete());
      const input = h.request();
      Object.assign(input.qoder!.business!, { sub_task: subTask });
      await (
        await h.provider.inference(input)
      ).completed;
      expect(h.wire.sends[0].body['metadata']).toMatchObject({
        business_id: 'turn-1',
        business_type: 'agent',
        sub_task: subTask,
      });
    },
  );

  it('keeps the snapshot on Provider replay after a truncated stream', async () => {
    const h = await setup();
    vi.useFakeTimers();
    h.wire.replies.push(
      () =>
        sse([
          {
            type: 'response.created',
            response: { id: 'truncated', model: 'auto' },
          },
        ]),
      () => complete(),
    );
    const input = h.request();
    Object.assign(input.qoder!.business!, { sub_task: 'title_generation' });
    Object.assign(input.qoder!.identity, { sourceSessionId: 'parent-session' });
    Object.assign(input.qoder!, { taskRouting: { taskId: 'agent_summary' } });
    const response = await h.provider.inference(input);
    Object.assign(input.qoder!.business!, { sub_task: 'mutated' });
    Object.assign(input.qoder!.identity, { sourceSessionId: 'mutated' });
    Object.assign(input.qoder!.taskRouting!, { taskId: 'mutated' });
    await vi.runAllTimersAsync();
    expect((await response.completed).blocks).toEqual([
      { type: 'text', text: 'answer' },
    ]);
    expect(h.wire.sends).toHaveLength(2);
    expect(h.wire.sends[0].headers['X-Request-Id']).not.toBe(
      h.wire.sends[1].headers['X-Request-Id'],
    );
    expect(h.wire.sends[0].body['metadata']).toEqual(
      h.wire.sends[1].body['metadata'],
    );
    expect(h.wire.sends[1].body['metadata']).toMatchObject({
      sub_task: 'title_generation',
      task_id: 'agent_summary',
      source_session_id: 'parent-session',
    });
    expect(
      h.wire.sends.map((send) => send.headers['X-Request-Set-Id']),
    ).toEqual(['turn-1', 'turn-1']);
  });

  it.each([
    [402, 'insufficient_quota'],
    [403, '122'],
  ])('classifies HTTP %i with code %s as quota without replaying', async (status, code) => {
    const h = await setup();
    h.wire.replies.push(
      () =>
        new Response(
          JSON.stringify({
            error: { code, message: 'quota exhausted' },
          }),
          { status },
        ),
    );
    await expect(
      (await h.provider.inference(h.request())).completed,
    ).rejects.toMatchObject({ kind: 'quota_exhausted', status, code });
    expect(h.wire.sends).toHaveLength(1);
  });

  it('shows the localized paid confirmation copy in the TUI error path', async () => {
    const h = await setup();
    initializeI18nService();
    cleanups.push(async () => resetI18nService());
    getI18nService().configureUi({
      locale: 'zh-CN',
      preference: 'zh-CN',
      dynamicContentEnabled: true,
    });
    h.wire.replies.push(
      () =>
        Response.json(
          {
            code: '145',
            subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
            modelKey: 'auto',
          },
          { status: 403 },
        ),
    );

    const failure = await (
      await h.provider.inference(h.request())
    ).completed.catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: 'quota_exhausted', code: '145' });
    const presentation = resolveErrorPresentation(failure, 'qoder');
    expect(presentation.displayErrorCode).toBe('145');
    expect(
      formatApiErrorDisplayMessage(
        presentation.displayErrorCode,
        presentation.fallbackMessage,
      ),
    ).toBe('赠送的免费额度已用尽，回答已暂停。继续回答将消耗您的付费额度。');
    expect(h.wire.sends).toHaveLength(1);
  });

  it.each([
    {
      name: 'direct 10605',
      error: { code: 10605, message: 'Queued' },
      code: '10605',
      kind: 'rate_limited',
      text: 'The model is busy and could not complete the request. Please try again later.',
    },
    {
      name: 'wrapped 10605',
      error: {
        code: '403',
        message: JSON.stringify({
          code: 10605,
          subCode: 'CALL_COUNT_LIMIT',
          retryAfterSeconds: 10,
        }),
      },
      code: '10605',
      kind: 'rate_limited',
      text: 'The model is busy and could not complete the request. Please try again later.',
    },
    {
      name: 'permission error mentioning 10605 in plain text',
      error: { code: '403', message: 'Permission denied. Reference 10605.' },
      code: '403',
      kind: 'auth',
      text: 'You do not have access to this model service. Please check your account permissions.',
    },
  ])('presents $name without replaying HTTP 403', async ({ error, code, kind, text }) => {
    const h = await setup();
    initializeI18nService();
    cleanups.push(async () => resetI18nService());
    h.wire.replies.push(() => Response.json({ error }, { status: 403 }));

    const response = await h.provider.inference(h.request());
    const failure = await response.completed.catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ code, kind, status: 403 });
    const presentation = resolveErrorPresentation(failure, 'qoder');
    expect(
      formatApiErrorDisplayMessage(
        presentation.displayErrorCode,
        presentation.fallbackMessage,
      ),
    ).toBe(text);
    expect(h.wire.sends).toHaveLength(1);
  });

  it('rejects malformed supplied business before dispatch instead of regenerating it', async () => {
    const h = await setup();
    const input = h.request();
    Object.assign(input.qoder!.business!, { id: '' });
    await expect(h.provider.inference(input)).rejects.toMatchObject({
      kind: 'invalid_request',
      phase: 'before_output',
      message: expect.stringContaining('non-empty id and type'),
    });
    expect(h.wire.sends).toHaveLength(0);
  });

  it('does not invent a shared business for standalone utility requests', async () => {
    const h = await setup();
    h.wire.replies.push(() => complete());
    const { qoder: _qoder, ...input } = h.request();
    await (
      await h.provider.inference(input)
    ).completed;
    expect(h.wire.sends[0].body['metadata']).not.toHaveProperty('business_id');
    expect(h.wire.sends[0].body['metadata']).not.toHaveProperty(
      'business_type',
    );
    expect(h.wire.sends[0].body['metadata']).not.toHaveProperty('sub_task');
    expect(h.wire.sends[0].body['metadata']).not.toHaveProperty('task_id');
    expect(h.wire.sends[0].body['metadata']).not.toHaveProperty(
      'source_session_id',
    );
  });

  it('honors cancellation before any physical send', async () => {
    const h = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.provider.inference({
        ...h.request(),
        control: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.wire.sends).toHaveLength(0);
  });
});
