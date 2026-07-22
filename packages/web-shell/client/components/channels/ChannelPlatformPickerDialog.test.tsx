/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ChannelPlatformPickerDialog } from './ChannelPlatformPickerDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);

afterEach(() => {
  act(() => root.render(null));
});

it('only exposes supported platforms and reports the selected descriptor', () => {
  const onSelect = vi.fn();
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ChannelPlatformPickerDialog
          open
          catalog={[
            {
              type: 'weixin',
              displayName: 'WeChat',
              manageable: true,
              fields: [],
              auth: ['qr'],
            },
            {
              type: 'dingtalk',
              displayName: 'DingTalk',
              manageable: true,
              fields: [],
              auth: ['credentials'],
            },
            {
              type: 'feishu',
              displayName: 'Feishu',
              manageable: true,
              fields: [],
              auth: ['credentials'],
            },
            {
              type: 'wecom',
              displayName: 'WeCom',
              manageable: true,
              fields: [],
              auth: ['credentials'],
            },
          ]}
          onOpenChange={vi.fn()}
          onSelect={onSelect}
        />
      </I18nProvider>,
    );
  });

  const search = document.querySelector<HTMLInputElement>('input')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(search, 'dingtalk');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.body.textContent).toContain('DingTalk');
  expect(document.body.textContent).not.toContain('WeChat');
  expect(document.body.textContent).not.toContain('Feishu');
  expect(document.body.textContent).not.toContain('WeCom');

  const platform = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent?.includes('DingTalk'),
  )!;
  act(() => platform.click());
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'dingtalk' }),
  );
});
