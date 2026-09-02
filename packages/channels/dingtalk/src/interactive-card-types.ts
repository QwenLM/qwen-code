export interface DingtalkInteractiveCardConfig {
  enabled: boolean;
  statusCard: { enabled: boolean };
  questionCard: { enabled: boolean; timeoutMs: number };
}

export interface DingtalkCardCallback {
  outTrackId: string;
  actionId: string;
  actorId: string;
  formData: Record<string, unknown>;
  hasBusinessPayload?: boolean;
  isCancel?: boolean;
}

export type DingtalkCardCallbackResult =
  | { kind: 'accepted'; execute: () => Promise<void> }
  | {
      kind: 'forbidden';
      actorId: string;
      target: { chatId: string; isGroup: boolean };
    }
  | { kind: 'ignored'; actorId?: string };

export const DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM = 0;
// Node clamps setTimeout delays above 2^31 - 1 ms to 1 ms, which would
// expire cards instantly; cap parsed timeouts at that maximum instead.
export const DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS = 2_147_483_647;
const DEFAULT_QUESTION_TIMEOUT_MS = 270_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseEmbeddedRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== 'string') {
    return asRecord(value);
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseBooleanLike(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function optionalBoolean(
  value: unknown,
  path: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`DingTalk interactiveCards.${path} must be a boolean.`);
  }
  return value;
}

export function parseDingtalkInteractiveCardConfig(
  value: unknown,
): DingtalkInteractiveCardConfig {
  if (value !== undefined && !asRecord(value)) {
    throw new Error('DingTalk interactiveCards must be an object.');
  }
  const configured = value !== undefined;
  const root = asRecord(value) ?? {};
  const status = asRecord(root['statusCard']);
  const question = asRecord(root['questionCard']);
  if (root['statusCard'] !== undefined && !status) {
    throw new Error('DingTalk interactiveCards.statusCard must be an object.');
  }
  if (root['questionCard'] !== undefined && !question) {
    throw new Error(
      'DingTalk interactiveCards.questionCard must be an object.',
    );
  }
  const timeoutMs =
    question?.['timeoutMs'] === undefined
      ? DEFAULT_QUESTION_TIMEOUT_MS
      : question['timeoutMs'];
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM
  ) {
    throw new Error(
      'DingTalk interactiveCards.questionCard.timeoutMs must be a finite positive number.',
    );
  }
  return {
    enabled: optionalBoolean(root['enabled'], 'enabled', configured),
    statusCard: {
      enabled: optionalBoolean(status?.['enabled'], 'statusCard.enabled', true),
    },
    questionCard: {
      enabled: optionalBoolean(
        question?.['enabled'],
        'questionCard.enabled',
        true,
      ),
      timeoutMs: Math.min(
        timeoutMs,
        DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS,
      ),
    },
  };
}

export function parseDingtalkCardCallback(
  value: unknown,
): DingtalkCardCallback | undefined {
  const root = parseEmbeddedRecord(value);
  if (!root) return undefined;
  const embeddedValue = parseEmbeddedRecord(root['value']);
  const embeddedContent = parseEmbeddedRecord(root['content']);
  const privateSources = [embeddedValue, embeddedContent, root]
    .map((source) => parseEmbeddedRecord(source?.['cardPrivateData']))
    .filter(
      (source): source is Record<string, unknown> => source !== undefined,
    );
  const sources = [
    embeddedValue,
    embeddedContent,
    ...privateSources,
    root,
  ].filter((source): source is Record<string, unknown> => source !== undefined);
  const pickString = (...keys: string[]): string | undefined => {
    for (const source of sources) {
      for (const key of keys) {
        const candidate = source[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }
      }
    }
    return undefined;
  };
  const privateData = privateSources[0];
  const actionIds = privateData?.['actionIds'];
  const actionId =
    (Array.isArray(actionIds) &&
    typeof actionIds[0] === 'string' &&
    actionIds[0].trim()
      ? actionIds[0].trim()
      : undefined) ?? pickString('actionValue', 'eventKey', 'actionId');
  const outTrackId = pickString('outTrackId');
  const actorId = parseDingtalkCardActorId(root);
  if (!outTrackId || !actionId || !actorId) return undefined;
  const params = sources
    .map((source) => parseEmbeddedRecord(source['params']))
    .find((source) => source !== undefined);
  const formData = sources
    .flatMap((source) => [
      parseEmbeddedRecord(source['formData']),
      parseEmbeddedRecord(parseEmbeddedRecord(source['params'])?.['form']),
    ])
    .find((source) => source !== undefined);
  const hasCancelField =
    params !== undefined &&
    Object.prototype.hasOwnProperty.call(params, 'user_cancel');
  return {
    outTrackId,
    actionId,
    actorId,
    formData: formData ?? {},
    hasBusinessPayload: formData !== undefined || hasCancelField,
    isCancel: hasCancelField && parseBooleanLike(params['user_cancel']),
  };
}

export function parseDingtalkCardActorId(value: unknown): string | undefined {
  const root = parseEmbeddedRecord(value);
  if (!root) return undefined;
  return ['userId', 'senderStaffId', 'senderId']
    .map((key) => root[key])
    .find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim().length > 0,
    )
    ?.trim();
}
