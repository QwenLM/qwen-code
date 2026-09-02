import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DingtalkInteractiveCardClient,
  QUESTION_CARD_TEMPLATE_ID,
  STATUS_CARD_TEMPLATE_ID,
} from './interactive-card-client.js';

const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createClient(): DingtalkInteractiveCardClient {
  return new DingtalkInteractiveCardClient({
    robotCode: 'robot-code',
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    fetch: fetchMock,
  });
}

describe('DingtalkInteractiveCardClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response());
  });

  it('creates and delivers a group status card with string parameters', async () => {
    await createClient().createAndDeliver({
      templateId: STATUS_CARD_TEMPLATE_ID,
      outTrackId: 'status-1',
      target: { chatId: 'cid-group', isGroup: true },
      cardParamMap: { content: 'hello', flowStatus: 2 },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver',
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': 'access-token',
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      cardTemplateId: STATUS_CARD_TEMPLATE_ID,
      outTrackId: 'status-1',
      cardData: {
        cardParamMap: { content: 'hello', flowStatus: '2' },
      },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
      openSpaceId: 'dtv1.card//IM_GROUP.cid-group',
      userIdType: 1,
      imGroupOpenDeliverModel: {
        robotCode: 'robot-code',
        extension: { dynamicSummary: 'true' },
      },
    });
  });

  it('creates and delivers a direct question card', async () => {
    await createClient().createAndDeliver({
      templateId: QUESTION_CARD_TEMPLATE_ID,
      outTrackId: 'question-1',
      target: { chatId: 'user-1', isGroup: false },
      cardParamMap: { form: { fields: [] } },
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject(
      {
        openSpaceId: 'dtv1.card//IM_ROBOT.user-1',
        imRobotOpenDeliverModel: {
          spaceType: 'IM_ROBOT',
          robotCode: 'robot-code',
          extension: { dynamicSummary: 'true' },
        },
      },
    );
  });

  it('opens or updates streaming with the DingTalk full-snapshot contract', async () => {
    await createClient().openOrUpdateStream({
      outTrackId: 'status-1',
      key: 'content',
      content: 'snapshot',
      finalize: false,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.dingtalk.com/v1.0/card/streaming');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      outTrackId: 'status-1',
      guid: expect.any(String),
      key: 'content',
      content: 'snapshot',
      isFull: true,
      isFinalize: false,
      isError: false,
    });
  });

  it('updates instance variables as strings', async () => {
    await createClient().updateInstance({
      outTrackId: 'status-1',
      cardParamMap: { flowStatus: 3, content: 'done' },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.dingtalk.com/v1.0/card/instances');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      outTrackId: 'status-1',
      cardData: {
        cardParamMap: { flowStatus: '3', content: 'done' },
      },
      cardUpdateOptions: { updateCardDataByKey: true },
    });
  });

  it('rejects HTTP and per-recipient delivery failures', async () => {
    fetchMock.mockResolvedValueOnce(response({ message: 'forbidden' }, 403));
    await expect(
      createClient().updateInstance({
        outTrackId: 'status-1',
        cardParamMap: {},
      }),
    ).rejects.toThrow('HTTP 403');

    fetchMock.mockResolvedValueOnce(
      response({
        result: {
          deliverResults: [{ success: false, errorMsg: 'template denied' }],
        },
      }),
    );
    await expect(
      createClient().createAndDeliver({
        templateId: QUESTION_CARD_TEMPLATE_ID,
        outTrackId: 'question-1',
        target: { chatId: 'user-1', isGroup: false },
        cardParamMap: {},
      }),
    ).rejects.toThrow(`${QUESTION_CARD_TEMPLATE_ID}: template denied`);
  });
});
