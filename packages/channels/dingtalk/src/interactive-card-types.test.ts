import { describe, expect, it } from 'vitest';
import {
  DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM,
  DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS,
  parseDingtalkCardCallback,
  parseDingtalkInteractiveCardConfig,
} from './interactive-card-types.js';
import * as interactiveCardTypes from './interactive-card-types.js';
import { plugin } from './index.js';

describe('interactive card config', () => {
  it('keeps management descriptor values compatible with the runtime parser', () => {
    const interactiveCards = plugin.management?.fields.find(
      (field) => field.key === 'interactiveCards',
    );
    const questionCard = interactiveCards?.properties?.find(
      (field) => field.key === 'questionCard',
    );
    const permissionCard = interactiveCards?.properties?.find(
      (field) => field.key === 'permissionCard',
    );
    const timeout = questionCard?.properties?.find(
      (field) => field.key === 'timeoutMs',
    );

    expect(DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM).toBe(0);
    expect(
      timeout?.kind === 'number' ? timeout.exclusiveMinimum : undefined,
    ).toBe(DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM);
    const permissionTimeout = permissionCard?.properties?.find(
      (field) => field.key === 'timeoutMs',
    );
    expect(
      permissionTimeout?.kind === 'number'
        ? permissionTimeout.exclusiveMinimum
        : undefined,
    ).toBe(DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM);
    const descriptorAdmittedSamples = [
      {},
      { enabled: false },
      { statusCard: {} },
      { statusCard: { enabled: false } },
      { questionCard: {} },
      { permissionCard: {} },
      {
        questionCard: {
          enabled: false,
          timeoutMs: DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM + 1,
        },
      },
      {
        permissionCard: {
          enabled: false,
          timeoutMs: DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM + 1,
        },
      },
    ];
    for (const sample of descriptorAdmittedSamples) {
      expect(() => parseDingtalkInteractiveCardConfig(sample)).not.toThrow();
    }
  });

  it('keeps omitted cards disabled while treating an object as opt-in', () => {
    expect(parseDingtalkInteractiveCardConfig(undefined)).toEqual({
      enabled: false,
      statusCard: { enabled: true },
      questionCard: { enabled: true, timeoutMs: 270_000 },
      permissionCard: { enabled: true, timeoutMs: 270_000 },
    });
    expect(parseDingtalkInteractiveCardConfig({})).toEqual({
      enabled: true,
      statusCard: { enabled: true },
      questionCard: { enabled: true, timeoutMs: 270_000 },
      permissionCard: { enabled: true, timeoutMs: 270_000 },
    });
  });

  it('supports explicit and independent disabling', () => {
    expect(
      parseDingtalkInteractiveCardConfig({
        enabled: true,
        statusCard: { enabled: false },
        questionCard: { enabled: true, timeoutMs: 1_000 },
        permissionCard: { enabled: false, timeoutMs: 2_000 },
      }),
    ).toEqual({
      enabled: true,
      statusCard: { enabled: false },
      questionCard: { enabled: true, timeoutMs: 1_000 },
      permissionCard: { enabled: false, timeoutMs: 2_000 },
    });
  });

  it('rejects invalid nested values and timeouts', () => {
    expect(() =>
      parseDingtalkInteractiveCardConfig({
        questionCard: {
          timeoutMs: DINGTALK_INTERACTIVE_CARD_TIMEOUT_EXCLUSIVE_MINIMUM,
        },
      }),
    ).toThrow('questionCard.timeoutMs');
    expect(() =>
      parseDingtalkInteractiveCardConfig({
        questionCard: { timeoutMs: Number.POSITIVE_INFINITY },
      }),
    ).toThrow('questionCard.timeoutMs');
    expect(() =>
      parseDingtalkInteractiveCardConfig({ statusCard: { enabled: 'yes' } }),
    ).toThrow('statusCard.enabled');
    expect(() =>
      parseDingtalkInteractiveCardConfig({
        permissionCard: { timeoutMs: 0 },
      }),
    ).toThrow('permissionCard.timeoutMs');
    expect(() =>
      parseDingtalkInteractiveCardConfig({ permissionCard: 'yes' }),
    ).toThrow('permissionCard must be an object');
  });

  it('clamps question timeouts at the setTimeout maximum delay', () => {
    expect(
      parseDingtalkInteractiveCardConfig({
        questionCard: {
          timeoutMs: DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS + 1,
        },
      }).questionCard.timeoutMs,
    ).toBe(DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS);
  });

  it('clamps permission timeouts at the setTimeout maximum delay', () => {
    expect(
      parseDingtalkInteractiveCardConfig({
        permissionCard: {
          timeoutMs: DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS + 1,
        },
      }).permissionCard.timeoutMs,
    ).toBe(DINGTALK_INTERACTIVE_CARD_TIMEOUT_MAXIMUM_MS);
  });
});

describe('card callback parser', () => {
  it('extracts a trusted actor from an otherwise incomplete callback', () => {
    const parseActorId = (
      interactiveCardTypes as unknown as {
        parseDingtalkCardActorId?: (value: unknown) => string | undefined;
      }
    ).parseDingtalkCardActorId;

    expect(parseActorId).toBeTypeOf('function');
    expect(
      parseActorId?.({
        userId: ' actor-1 ',
        value: JSON.stringify({ outTrackId: 'missing-action' }),
      }),
    ).toBe('actor-1');
  });

  it('normalizes embedded payloads, owner, action, and form data', () => {
    expect(
      parseDingtalkCardCallback({
        userId: ' owner-1 ',
        value: JSON.stringify({
          outTrackId: 'question-1',
          cardPrivateData: { actionIds: ['submit'] },
          formData: { '0': 'Beijing' },
        }),
      }),
    ).toEqual({
      outTrackId: 'question-1',
      actionId: 'submit',
      actorId: 'owner-1',
      formData: { '0': 'Beijing' },
      hasBusinessPayload: true,
      isCancel: false,
    });
  });

  it('parses the built-in form template callback shape', () => {
    expect(
      parseDingtalkCardCallback({
        userId: 'owner-1',
        outTrackId: 'question-1',
        content: JSON.stringify({
          cardPrivateData: {
            actionIds: ['request-1'],
            params: { form: { '0': 'Beijing' } },
          },
        }),
      }),
    ).toEqual({
      outTrackId: 'question-1',
      actionId: 'request-1',
      actorId: 'owner-1',
      formData: { '0': 'Beijing' },
      hasBusinessPayload: true,
      isCancel: false,
    });
  });

  it('recognizes the built-in cancel and non-business callback shapes', () => {
    expect(
      parseDingtalkCardCallback({
        userId: 'owner-1',
        outTrackId: 'question-1',
        content: JSON.stringify({
          cardPrivateData: {
            actionIds: ['request-1'],
            params: { user_cancel: 'true' },
          },
        }),
      }),
    ).toMatchObject({
      actionId: 'request-1',
      hasBusinessPayload: true,
      isCancel: true,
    });
    expect(
      parseDingtalkCardCallback({
        userId: 'owner-1',
        outTrackId: 'question-1',
        content: JSON.stringify({
          cardPrivateData: {
            actionIds: ['request-1'],
            params: { fromConfig: true },
          },
        }),
      }),
    ).toMatchObject({
      hasBusinessPayload: false,
      isCancel: false,
    });
  });

  it('fails closed for malformed or incomplete callbacks', () => {
    expect(parseDingtalkCardCallback('{broken')).toBeUndefined();
    expect(
      parseDingtalkCardCallback({
        value: JSON.stringify({ outTrackId: 'card-1', actionValue: 'stop' }),
      }),
    ).toBeUndefined();
  });

  it('trusts only top-level callback identity fields', () => {
    expect(
      parseDingtalkCardCallback({
        userId: 'real-owner',
        value: JSON.stringify({
          userId: 'spoofed-owner',
          outTrackId: 'card-1',
          actionValue: 'stop',
        }),
      }),
    ).toMatchObject({ actorId: 'real-owner' });
    expect(
      parseDingtalkCardCallback({
        value: JSON.stringify({
          userId: 'spoofed-owner',
          outTrackId: 'card-1',
          actionValue: 'stop',
        }),
      }),
    ).toBeUndefined();
  });
});
