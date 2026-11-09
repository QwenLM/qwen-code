import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStartQrConnect } = vi.hoisted(() => ({
  mockStartQrConnect: vi.fn(),
}));

vi.mock('@tencent-connect/qqbot-connector', () => ({
  qrConnect: vi.fn(),
  startQrConnect: mockStartQrConnect,
}));

import { plugin } from './index.js';

const fields = () => plugin.management!.fields;
const field = (key: string) => fields().find((f) => f.key === key);
const validate = (config: Record<string, unknown>) =>
  plugin.management!.validateConfig?.(config);

describe('QQ management descriptor', () => {
  it('exposes the QQ-specific config surface without redeclaring shared fields', () => {
    const keys = fields().map((f) => f.key);
    expect(keys).toEqual([
      'appID',
      'appSecret',
      'sandbox',
      'groupAllPolicy',
      'keywordTriggers',
      'allowMention',
      'chatTypes',
      'cron-msg-experimental',
      'bufferFlushLength',
      'maxReconnectAttempts',
      'maxFlushRetries',
      'maxGwRetries',
    ]);
    // These are appended by managementFieldsWithSharedControls(); declaring
    // them here would duplicate or shadow the shared controls.
    for (const shared of [
      'privatePolicy',
      'groupPolicy',
      'sessionScope',
      'outputMode',
      'instructions',
    ]) {
      expect(keys).not.toContain(shared);
    }
  });

  it('keeps credentials optional so the QR path stays reachable', () => {
    expect(field('appID')?.required).toBeFalsy();
    expect(field('appSecret')?.required).toBeFalsy();
    expect(field('appSecret')?.kind).toBe('secret');
    // The runtime fallback chain must not be short-circuited by a required
    // config field, or parseChannelConfig() rejects before QQChannel exists.
    expect(plugin.requiredConfigFields).toEqual([]);
  });

  it('declares allowMention with a boolean true default matching the adapter', () => {
    // QQChannel reads `allowMention !== false`, so an editor that writes the
    // zero value would silently disable mention passthrough.
    expect(field('allowMention')?.kind).toBe('boolean');
    expect(field('allowMention')?.default).toBe(true);
  });

  it('declares boolean defaults as booleans, not strings', () => {
    for (const key of ['sandbox', 'allowMention', 'cron-msg-experimental']) {
      expect(typeof field(key)?.default).toBe('boolean');
    }
  });
});

describe('QQ groupAllPolicy cross-field validation', () => {
  const usable = {
    sessionScope: 'single',
    groups: { '*': { requireMention: false } },
  };

  it('accepts the default log policy without extra settings', () => {
    expect(validate({})).toBeUndefined();
    expect(validate({ groupAllPolicy: 'log' })).toBeUndefined();
  });

  it('rejects non-mention policies without the single session scope', () => {
    for (const policy of ['keyword', 'all']) {
      expect(
        validate({
          groupAllPolicy: policy,
          keywordTriggers: ['hi'],
          groups: { '*': { requireMention: false } },
        }),
      ).toContain('One Shared Session');
    }
  });

  it('rejects non-mention policies when the group gate would drop them', () => {
    // requireMention defaults to true in GroupGate, so an absent value must
    // be rejected just like an explicit true.
    for (const groups of [
      undefined,
      {},
      { '*': {} },
      { '*': { requireMention: true } },
    ]) {
      expect(
        validate({ groupAllPolicy: 'all', sessionScope: 'single', groups }),
      ).toContain('Require Mention');
    }
  });

  it('requires keywords for the keyword policy', () => {
    expect(validate({ ...usable, groupAllPolicy: 'keyword' })).toContain(
      'keyword trigger',
    );
    expect(
      validate({ ...usable, groupAllPolicy: 'keyword', keywordTriggers: [] }),
    ).toContain('keyword trigger');
    expect(
      validate({
        ...usable,
        groupAllPolicy: 'keyword',
        keywordTriggers: ['hi'],
      }),
    ).toBeUndefined();
  });

  it('accepts the all policy once scope and group gate agree', () => {
    expect(validate({ ...usable, groupAllPolicy: 'all' })).toBeUndefined();
  });
});

describe('QQ qrLogin capability', () => {
  beforeEach(() => {
    mockStartQrConnect.mockReset();
    mockStartQrConnect.mockReturnValue(() => {});
  });

  it('starts the connector without console output and returns its dispose', () => {
    const dispose = vi.fn();
    mockStartQrConnect.mockReturnValue(dispose);
    const controller = new AbortController();
    const handlers = {
      onQrCode: vi.fn(),
      onExpired: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    };

    expect(plugin.management!.qrLogin!.start(handlers, controller.signal)).toBe(
      dispose,
    );
    const [, options] = mockStartQrConnect.mock.calls[0]!;
    expect(options.displayQrCodeToConsole).toBe(false);
    expect(options.signal).toBe(controller.signal);
  });

  it('maps connector credentials onto management field keys', () => {
    const handlers = {
      onQrCode: vi.fn(),
      onExpired: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    };
    plugin.management!.qrLogin!.start(handlers, new AbortController().signal);
    const [callbacks] = mockStartQrConnect.mock.calls[0]!;

    callbacks.onQrDisplayed('https://q.qq.com/connect?task_id=t');
    expect(handlers.onQrCode).toHaveBeenCalledWith(
      'https://q.qq.com/connect?task_id=t',
    );

    callbacks.onQrExpired();
    expect(handlers.onExpired).toHaveBeenCalledOnce();

    callbacks.onSuccess([{ appId: 'app-1', appSecret: 'secret-1' }]);
    // Keys must match the descriptor so the daemon can persist generically.
    expect(handlers.onSuccess).toHaveBeenCalledWith({
      appID: 'app-1',
      appSecret: 'secret-1',
    });
    expect(field('appID')).toBeDefined();
    expect(field('appSecret')).toBeDefined();
  });

  it('fails rather than persisting empty credentials', () => {
    const handlers = {
      onQrCode: vi.fn(),
      onExpired: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    };
    plugin.management!.qrLogin!.start(handlers, new AbortController().signal);
    const [callbacks] = mockStartQrConnect.mock.calls[0]!;

    callbacks.onSuccess([]);
    expect(handlers.onSuccess).not.toHaveBeenCalled();
    expect(handlers.onFailure).toHaveBeenCalledOnce();
  });
});
