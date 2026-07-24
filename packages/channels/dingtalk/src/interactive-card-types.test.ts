import { describe, expect, it } from 'vitest';
import {
  parseDingtalkCardCallback,
  parseDingtalkInteractiveCardConfig,
} from './interactive-card-types.js';

describe('interactive card config', () => {
  it('applies defaults and supports independent disabling', () => {
    expect(parseDingtalkInteractiveCardConfig(undefined)).toEqual({
      enabled: true,
      statusCard: { enabled: true },
      questionCard: { enabled: true, timeoutMs: 300_000 },
    });
    expect(
      parseDingtalkInteractiveCardConfig({
        enabled: true,
        statusCard: { enabled: false },
        questionCard: { enabled: true, timeoutMs: 1_000 },
      }),
    ).toEqual({
      enabled: true,
      statusCard: { enabled: false },
      questionCard: { enabled: true, timeoutMs: 1_000 },
    });
  });

  it('rejects invalid nested values and timeouts', () => {
    expect(() =>
      parseDingtalkInteractiveCardConfig({
        questionCard: { timeoutMs: Number.POSITIVE_INFINITY },
      }),
    ).toThrow('questionCard.timeoutMs');
    expect(() =>
      parseDingtalkInteractiveCardConfig({ statusCard: { enabled: 'yes' } }),
    ).toThrow('statusCard.enabled');
  });
});

describe('card callback parser', () => {
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
      ownerId: 'owner-1',
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
      ownerId: 'owner-1',
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
    ).toMatchObject({ ownerId: 'real-owner' });
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
