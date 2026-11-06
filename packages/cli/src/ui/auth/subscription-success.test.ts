/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it } from 'vitest';
import { setLanguageAsync } from '../../i18n/index.js';
import { subscriptionSuccessMessage } from './subscription-success.js';

afterEach(() => setLanguageAsync('en'));

it.each(['plus', 'pro'])(
  'renders the four-line Chinese summary for %s',
  async (plan) => {
    await setLanguageAsync('zh');
    const message = subscriptionSuccessMessage(
      {
        sub: 'user',
        name: 'Builder',
        email: 'builder@example.com',
        member_type: plan,
      },
      'qwen3.8-flash',
    );
    expect(message.split('\n')).toEqual([
      '✓ 登录成功 · builder@example.com',
      `✓ 当前套餐：Qwen ${plan === 'plus' ? 'Plus' : 'Pro'}，已可使用 Qwen Code`,
      '  模型：qwen3.8-flash，输入 /upgrade 升级套餐，/usage 查看用量，/model 切换模型。',
      '  常用命令：/usage   /upgrade   /model   /status   /logout',
    ]);
  },
);

it('uses the actual selected model and account in the English summary', async () => {
  await setLanguageAsync('en');
  expect(
    subscriptionSuccessMessage(
      {
        sub: 'user',
        name: 'Other',
        email: 'other@example.com',
        member_type: 'pro',
      },
      'server-returned-model',
    ).split('\n'),
  ).toEqual([
    '✓ Signed in successfully · other@example.com',
    '✓ Current plan: Qwen Pro. Qwen Code is ready.',
    '  Model: server-returned-model. Run /upgrade to upgrade your plan, /usage to view usage, or /model to switch models.',
    '  Common commands: /usage   /upgrade   /model   /status   /logout',
  ]);
});

it('keeps the actual browser link between the model and common commands', () => {
  const url =
    'https://chat.qwen.ai/authorize?user_code=TEST-CODE&client=cli&entry=qwen_code&paywallScene=cli';
  const message = subscriptionSuccessMessage(
    {
      sub: 'user',
      name: 'Builder',
      email: 'builder@example.com',
      member_type: 'pro',
    },
    'server-model',
    url,
  );
  expect(message).toContain("If the browser didn't open, visit:");
  expect(message.indexOf('Model:')).toBeLessThan(message.indexOf(url));
  expect(message.indexOf(url)).toBeLessThan(
    message.indexOf('Common commands:'),
  );
});
