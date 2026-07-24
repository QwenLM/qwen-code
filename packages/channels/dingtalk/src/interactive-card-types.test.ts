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
});
