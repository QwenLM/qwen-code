/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseNetworkTargetUrl } from '@qwen-code/network-policy';
import { parseGenericWebhookConfig } from './config.js';
import { plugin } from './index.js';

describe('generic webhook configuration', () => {
  it('keeps URL and Bearer authentication secret and declares the logical target', () => {
    expect(plugin.outboundOnly).toBe(true);
    expect(plugin.defaultDeliveryTarget).toEqual({
      type: 'chat',
      id: 'default',
      label: 'Configured endpoint',
    });
    expect(plugin.requiredConfigFields).toEqual(['webhookUrl']);
    expect(plugin.envResolvableConfigFields).toEqual(['bearerToken']);
    expect(plugin.management?.fields).toMatchObject([
      {
        key: 'webhookUrl',
        kind: 'secret',
        required: true,
        envResolvable: true,
      },
      { key: 'bearerToken', kind: 'secret', envResolvable: true },
      { key: 'allowPrivateNetwork', kind: 'boolean' },
    ]);
  });

  it('preserves a complete endpoint and defaults to the public policy', () => {
    const webhookUrl = 'https://receiver.example:8443/a%20b?key=private-value';
    expect(parseGenericWebhookConfig({ webhookUrl })).toEqual({
      webhookUrl,
      networkPolicy: 'public',
    });
    expect(
      parseGenericWebhookConfig({
        webhookUrl: 'http://127.0.0.1:8080/deliver',
        allowPrivateNetwork: true,
        bearerToken: 'a-Z_0.~+/==',
      }),
    ).toEqual({
      webhookUrl: 'http://127.0.0.1:8080/deliver',
      networkPolicy: 'allow-private',
      bearerToken: 'a-Z_0.~+/==',
    });
  });

  it.each([
    ['https://receiver.example', 'https://receiver.example/'],
    ['HTTPS://RECEIVER.EXAMPLE:443/hook', 'https://receiver.example/hook'],
    ['https://例子.测试/hook', 'https://xn--fsqu00a.xn--0zwm56d/hook'],
    [
      'https://receiver.example/通知?状态=完成',
      'https://receiver.example/%E9%80%9A%E7%9F%A5?%E7%8A%B6%E6%80%81=%E5%AE%8C%E6%88%90',
    ],
  ])('allows standard URL normalization for %s', (webhookUrl, href) => {
    const config = parseGenericWebhookConfig({ webhookUrl });
    expect(config.webhookUrl).toBe(webhookUrl);
    expect(plugin.management!.validateConfig!({ webhookUrl })).toBeUndefined();
    expect(
      parseNetworkTargetUrl(config.webhookUrl, config.networkPolicy).href,
    ).toBe(href);
  });

  it.each([
    undefined,
    null,
    '',
    'receiver.example/path',
    'https:receiver.example/path',
    'https:///receiver.example/path',
    ' https://receiver.example',
    'https://receiver.example\n',
    'https://receiver.example/has space',
    'https://receiver.example/\u0000private-value',
    'https://receiver.example\\private-value',
    'https://user:private-value@receiver.example',
    'https://@receiver.example',
    'https://receiver.example/#private-value',
    'https://receiver.example/#',
    'ftp://receiver.example/private-value',
    'https://receiver.example:99999/private-value',
    'http://receiver.example/private-value',
    '$UNRESOLVED_ENDPOINT',
  ])(
    'rejects an invalid runtime endpoint without echoing it: %s',
    (webhookUrl) => {
      expect(() => parseGenericWebhookConfig({ webhookUrl })).toThrow(
        'Generic webhook URL must be',
      );
      expect(
        String(plugin.management!.validateConfig!({ webhookUrl })),
      ).not.toContain('private-value');
    },
  );

  it.each([
    '',
    ' ',
    'token with space',
    'private-value\r\nInjected: yes',
    'é',
    '=',
    '$UNRESOLVED_TOKEN',
    42,
    null,
  ])('rejects invalid Bearer values without echoing them', (bearerToken) => {
    const config = { webhookUrl: 'https://receiver.example', bearerToken };
    expect(() => parseGenericWebhookConfig(config)).toThrow(
      /^Generic webhook Bearer token must be a valid non-empty token\.$/,
    );
    expect(String(plugin.management!.validateConfig!(config))).not.toContain(
      'private-value',
    );
  });

  it('allows references only during management validation and still checks other fields', () => {
    const validate = plugin.management!.validateConfig!;
    expect(
      validate({ webhookUrl: '$CUSTOM_URL', bearerToken: '$CUSTOM_TOKEN' }),
    ).toBeUndefined();
    expect(
      validate({ webhookUrl: '$CUSTOM_URL', bearerToken: 'bad token' }),
    ).toMatch(/Bearer token/);
    expect(
      validate({ webhookUrl: '$CUSTOM_URL', allowPrivateNetwork: 'true' }),
    ).toMatch(/boolean/);
    expect(validate({ webhookUrl: '$CUSTOM-URL' })).toMatch(/URL/);
    expect(validate({ webhookUrl: '$CUSTOM_URL\n' })).toMatch(/URL/);
    expect(
      validate({
        webhookUrl: 'https://receiver.example',
        bearerToken: '$BAD-TOKEN',
      }),
    ).toMatch(/Bearer token/);
    for (const value of [null, 1, 'false']) {
      expect(() =>
        parseGenericWebhookConfig({
          webhookUrl: 'https://receiver.example',
          allowPrivateNetwork: value,
        }),
      ).toThrow(/boolean/);
    }
  });
});
