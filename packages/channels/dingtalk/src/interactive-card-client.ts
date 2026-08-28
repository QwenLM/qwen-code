import { randomUUID } from 'node:crypto';

export const STATUS_CARD_TEMPLATE_ID =
  '675cde2f-f526-40cb-b828-f5b2b57b8b77.schema';
export const QUESTION_CARD_TEMPLATE_ID =
  'c2a6355b-9724-4f7e-9653-d33fcb3311bb.schema';

const DINGTALK_API = 'https://api.dingtalk.com';
const CARD_FETCH_TIMEOUT_MS = 10_000;

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

export class DingtalkCardRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DingtalkCardRequestError';
  }
}

export function isRetryableDingtalkCardError(error: unknown): boolean {
  return !(error instanceof DingtalkCardRequestError) || error.retryable;
}

type CardParamMap = Record<string, unknown>;

export interface CreateCardInput {
  templateId: string;
  outTrackId: string;
  target: { chatId: string; isGroup: boolean };
  cardParamMap: CardParamMap;
}

export interface StreamCardInput {
  outTrackId: string;
  key: string;
  content: string;
  finalize: boolean;
  isError?: boolean;
}

export interface UpdateCardInput {
  outTrackId: string;
  cardParamMap: CardParamMap;
}

export interface DingtalkInteractiveCardClientOptions {
  robotCode: string;
  getAccessToken(): Promise<string>;
  fetch?: typeof fetch;
}

function stringifyCardParamMap(
  cardParamMap: CardParamMap,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cardParamMap).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
}

export class DingtalkInteractiveCardClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: DingtalkInteractiveCardClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async createAndDeliver(input: CreateCardInput): Promise<void> {
    const targetModel = input.target.isGroup
      ? {
          imGroupOpenDeliverModel: {
            robotCode: this.options.robotCode,
            extension: { dynamicSummary: 'true' },
          },
        }
      : {
          imRobotOpenDeliverModel: {
            spaceType: 'IM_ROBOT',
            robotCode: this.options.robotCode,
            extension: { dynamicSummary: 'true' },
          },
        };
    const data = await this.request(
      '/v1.0/card/instances/createAndDeliver',
      'POST',
      {
        cardTemplateId: input.templateId,
        outTrackId: input.outTrackId,
        cardData: {
          cardParamMap: stringifyCardParamMap(input.cardParamMap),
        },
        callbackType: 'STREAM',
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
        openSpaceId: input.target.isGroup
          ? `dtv1.card//IM_GROUP.${input.target.chatId}`
          : `dtv1.card//IM_ROBOT.${input.target.chatId}`,
        userIdType: 1,
        ...targetModel,
      },
      input.templateId,
    );
    const result =
      data && typeof data === 'object'
        ? (data as { result?: { deliverResults?: unknown } }).result
        : undefined;
    const deliveries = result?.deliverResults;
    if (Array.isArray(deliveries)) {
      const failure = deliveries.find(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as { success?: unknown }).success === false,
      ) as { errorMsg?: unknown } | undefined;
      if (failure) {
        throw new DingtalkCardRequestError(
          `${input.templateId}: ${
            typeof failure.errorMsg === 'string' && failure.errorMsg.trim()
              ? failure.errorMsg.trim()
              : 'DingTalk card delivery failed'
          }`,
          false,
        );
      }
    }
  }

  async openOrUpdateStream(input: StreamCardInput): Promise<void> {
    await this.request('/v1.0/card/streaming', 'PUT', {
      outTrackId: input.outTrackId,
      guid: randomUUID(),
      key: input.key,
      content: input.content,
      isFull: true,
      isFinalize: input.finalize,
      isError: input.isError ?? false,
    });
  }

  async updateInstance(input: UpdateCardInput): Promise<void> {
    await this.request('/v1.0/card/instances', 'PUT', {
      outTrackId: input.outTrackId,
      cardData: {
        cardParamMap: stringifyCardParamMap(input.cardParamMap),
      },
      cardUpdateOptions: { updateCardDataByKey: true },
    });
  }

  private async request(
    path: string,
    method: 'POST' | 'PUT',
    body: unknown,
    templateId?: string,
  ): Promise<unknown> {
    const token = await this.options.getAccessToken();
    const response = await this.fetch(`${DINGTALK_API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CARD_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new DingtalkCardRequestError(
        `DingTalk Card OpenAPI ${method} ${path} failed${templateId ? ` for ${templateId}` : ''}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
        isRetryableStatus(response.status),
      );
    }
    return response.json().catch(() => undefined);
  }
}
