/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';
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

let container: HTMLDivElement;
let root: Root;

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
  it('keeps save disabled until visible required credentials are valid', async () => {
    await act(async () => {
      root.render(
        <ChannelEditorDialog
          open
          catalog={catalog}
          expectedRevision="revision-1"
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent === 'Add channel',
    );
    expect(save).toBeInstanceOf(HTMLButtonElement);
    expect((save as HTMLButtonElement).disabled).toBe(true);
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
