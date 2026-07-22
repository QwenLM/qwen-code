/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { ChannelEditorDialog } from './ChannelEditorDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const catalog: DaemonChannelTypeDescriptor[] = [
  {
    type: 'custom',
    displayName: 'Custom',
    manageable: true,
    auth: ['credentials'],
    fields: [
      { key: 'token', label: 'Token', kind: 'secret', required: true },
      { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    ],
  },
];

const dingtalkCatalog: DaemonChannelTypeDescriptor[] = [
  {
    type: 'dingtalk',
    displayName: 'DingTalk',
    manageable: true,
    auth: ['credentials'],
    fields: [
      { key: 'clientId', label: 'Client ID', kind: 'string', required: true },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        kind: 'secret',
        required: true,
      },
    ],
  },
];

const credentialPolicyCatalogs = {
  feishu: {
    descriptor: {
      type: 'feishu',
      displayName: 'Feishu',
      manageable: true,
      auth: ['credentials'],
      fields: [
        { key: 'clientId', label: 'App ID', kind: 'string', required: true },
        {
          key: 'clientSecret',
          label: 'App Secret',
          kind: 'secret',
          required: true,
        },
      ],
    } satisfies DaemonChannelTypeDescriptor,
    title: 'Configure Feishu',
    idLabel: 'App ID',
    secretLabel: 'App Secret',
    idField: 'clientId',
    secretField: 'clientSecret',
  },
  wecom: {
    descriptor: {
      type: 'wecom',
      displayName: 'WeCom',
      manageable: true,
      auth: ['credentials'],
      fields: [
        { key: 'botId', label: 'Bot ID', kind: 'string', required: true },
        {
          key: 'secret',
          label: 'Bot Secret',
          kind: 'secret',
          required: true,
        },
        { key: 'wsUrl', label: 'WebSocket URL', kind: 'string' },
      ],
    } satisfies DaemonChannelTypeDescriptor,
    title: 'Configure WeCom',
    idLabel: 'Bot ID',
    secretLabel: 'Bot Secret',
    idField: 'botId',
    secretField: 'secret',
  },
} as const;

let container: HTMLDivElement;
let root: Root;

function english(node: ReactNode) {
  return <I18nProvider language="en">{node}</I18nProvider>;
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelEditorDialog', () => {
  it('only exposes DingTalk credentials and access policy', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        english(
          <ChannelEditorDialog
            open
            catalog={dingtalkCatalog}
            expectedRevision="revision-1"
            initialName="dingtalk"
            initialType="dingtalk"
            onOpenChange={vi.fn()}
            onSubmit={onSubmit}
          />,
        ),
      );
    });

    expect(document.body.textContent).toContain('Configure DingTalk');
    expect(document.body.textContent).toContain('Client ID (AppKey)');
    expect(document.body.textContent).toContain('Client Secret (AppSecret)');
    expect(document.body.textContent).toContain('Access policy');
    expect(document.body.textContent).toContain('Pairing');
    expect(document.body.textContent).toContain('Open');
    expect(document.querySelector('#channel-editor-name')).toBeNull();
    expect(document.body.textContent).not.toContain('Model and workspace');
    expect(document.body.textContent).not.toContain('Messaging policies');
    expect(document.body.textContent).not.toContain('Webhooks');

    const clientId = document.querySelector<HTMLInputElement>(
      '#dingtalk-credential-id',
    )!;
    const clientSecret = document.querySelector<HTMLInputElement>(
      '#dingtalk-credential-secret',
    )!;
    const save = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent === 'Save',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await enter(clientId, 'ding-client-id');
    await enter(clientSecret, 'ding-client-secret');
    const openPolicy = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent?.includes('Anyone or any group'),
    )!;
    act(() => openPolicy.click());
    expect(save.disabled).toBe(false);

    await act(async () => save.click());
    expect(onSubmit).toHaveBeenCalledWith('dingtalk', {
      expectedRevision: 'revision-1',
      config: {
        type: 'dingtalk',
        clientId: 'ding-client-id',
        senderPolicy: 'open',
        dmPolicy: 'open',
        groupPolicy: 'open',
      },
      secrets: {
        clientSecret: {
          operation: 'replace',
          value: 'ding-client-secret',
        },
      },
    });
  });

  it('preserves a stored DingTalk secret without mounting it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        english(
          <ChannelEditorDialog
            open
            catalog={dingtalkCatalog}
            expectedRevision="revision-1"
            instance={{
              name: 'dingtalk',
              config: {
                type: 'dingtalk',
                clientId: 'ding-client-id',
                senderPolicy: 'pairing',
              },
              secrets: {
                clientSecret: { present: true, source: 'literal' },
              },
              webhookSecrets: {},
              startsWithServe: false,
              runtime: { state: 'stopped' },
            }}
            onOpenChange={vi.fn()}
            onSubmit={onSubmit}
          />,
        ),
      );
    });

    const secret = document.querySelector<HTMLInputElement>(
      '#dingtalk-credential-secret',
    )!;
    expect(secret.value).toBe('');
    expect(secret.placeholder).toBe('Stored Client Secret');
    const save = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent === 'Save',
    )!;
    await act(async () => save.click());
    expect(onSubmit).toHaveBeenCalledWith(
      'dingtalk',
      expect.objectContaining({
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    );
  });

  it.each(Object.entries(credentialPolicyCatalogs))(
    'uses the focused credential and policy editor for %s',
    async (type, platform) => {
      const onSubmit = vi.fn().mockResolvedValue(true);
      await act(async () => {
        root.render(
          english(
            <ChannelEditorDialog
              open
              catalog={[platform.descriptor]}
              expectedRevision="revision-1"
              initialName={type}
              initialType={type}
              onOpenChange={vi.fn()}
              onSubmit={onSubmit}
            />,
          ),
        );
      });

      expect(document.body.textContent).toContain(platform.title);
      expect(document.body.textContent).toContain(platform.idLabel);
      expect(document.body.textContent).toContain(platform.secretLabel);
      expect(document.body.textContent).toContain('Access policy');
      expect(document.body.textContent).not.toContain('Model and workspace');
      expect(document.body.textContent).not.toContain('WebSocket URL');

      await enter(
        document.querySelector<HTMLInputElement>(`#${type}-credential-id`)!,
        'credential-id',
      );
      await enter(
        document.querySelector<HTMLInputElement>(`#${type}-credential-secret`)!,
        'credential-secret',
      );
      const save = Array.from(document.querySelectorAll('button')).find(
        (element) => element.textContent === 'Save',
      )!;
      await act(async () => save.click());

      expect(onSubmit).toHaveBeenCalledWith(type, {
        expectedRevision: 'revision-1',
        config: {
          type,
          [platform.idField]: 'credential-id',
          senderPolicy: 'pairing',
          dmPolicy: 'open',
          groupPolicy: 'open',
        },
        secrets: {
          [platform.secretField]: {
            operation: 'replace',
            value: 'credential-secret',
          },
        },
      });
    },
  );

  it('localizes representative editor labels in Simplified Chinese', async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ChannelEditorDialog
            open
            catalog={catalog}
            expectedRevision="revision-1"
            onOpenChange={vi.fn()}
            onSubmit={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    expect(document.body.textContent).toContain('添加频道');
    expect(document.body.textContent).toContain('输入凭据');
    expect(document.body.textContent).toContain('取消');
  });

  it('keeps save disabled until visible required credentials are valid', async () => {
    await act(async () => {
      root.render(
        english(
          <ChannelEditorDialog
            open
            catalog={catalog}
            expectedRevision="revision-1"
            workspaceCwd="/workspaces/current-project"
            onOpenChange={vi.fn()}
            onSubmit={vi.fn()}
          />,
        ),
      );
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent === 'Add channel',
    );
    expect(save).toBeInstanceOf(HTMLButtonElement);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('Current workspace');
    expect(document.body.textContent).toContain('/workspaces/current-project');
    expect(
      Array.from(document.querySelectorAll('input')).some(
        (input) => input.value === '/workspaces/current-project',
      ),
    ).toBe(false);
    expect(document.body.textContent).toContain('Enter credential');
    const credentialButton = Array.from(
      document.querySelectorAll('button'),
    ).find((element) => element.textContent?.includes('Enter credential'));
    expect(credentialButton).toBeInstanceOf(HTMLButtonElement);
    act(() => credentialButton!.click());
    expect(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.value,
    ).toBe('');
  });

  it('never mounts webhook or QQ secret sentinels in form controls', async () => {
    const webhookSecret = 'webhook-secret-dom-sentinel';
    const qqSecret = 'qq-secret-dom-sentinel';
    await act(async () => {
      root.render(
        english(
          <ChannelEditorDialog
            open
            catalog={[
              {
                type: 'qq',
                displayName: 'QQ',
                manageable: true,
                auth: ['credentials', 'qr'],
                fields: [
                  { key: 'appID', label: 'App ID', kind: 'string' },
                  { key: 'appSecret', label: 'App Secret', kind: 'secret' },
                ],
              },
            ]}
            expectedRevision="revision-1"
            instance={{
              name: 'qq-bot',
              config: {
                type: 'qq',
                appID: 'id',
                appSecret: qqSecret,
                webhooks: {
                  sources: {
                    github: { secret: webhookSecret, targets: {} },
                  },
                },
              },
              secrets: { appSecret: { present: true, source: 'literal' } },
              webhookSecrets: {
                github: { present: true, source: 'literal' },
              },
              startsWithServe: false,
              runtime: { state: 'stopped' },
            }}
            onOpenChange={vi.fn()}
            onSubmit={vi.fn()}
          />,
        ),
      );
    });

    const values = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input, textarea',
      ),
      (element) => element.value,
    ).join('\n');
    expect(values).not.toContain(webhookSecret);
    expect(values).not.toContain(qqSecret);
    expect(document.body.innerHTML).not.toContain(webhookSecret);
    expect(document.body.innerHTML).not.toContain(qqSecret);
  });

  it('disables save when an environment webhook becomes literal', async () => {
    await act(async () => {
      root.render(
        english(
          <ChannelEditorDialog
            open
            catalog={catalog}
            expectedRevision="revision-1"
            instance={{
              name: 'bot',
              config: {
                type: 'custom',
                webhooks: {
                  sources: {
                    github: { secretEnv: 'GITHUB_WEBHOOK_SECRET', targets: {} },
                  },
                },
              },
              secrets: { token: { present: true, source: 'literal' } },
              webhookSecrets: {
                github: { present: true, source: 'environment' },
              },
              startsWithServe: false,
              runtime: { state: 'stopped' },
            }}
            onOpenChange={vi.fn()}
            onSubmit={vi.fn()}
          />,
        ),
      );
    });

    const textarea = Array.from(document.querySelectorAll('textarea')).find(
      (element) => element.value.includes('GITHUB_WEBHOOK_SECRET'),
    );
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(
        textarea,
        JSON.stringify({ sources: { github: { targets: {} } } }),
      );
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(document.body.textContent).toContain(
      'Enter a replacement webhook secret or restore secretEnv.',
    );
    const save = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent === 'Save changes',
    );
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });
});
