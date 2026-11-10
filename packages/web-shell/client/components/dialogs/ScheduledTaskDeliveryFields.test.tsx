// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonChannelDelivery,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';

const { useChannels, actions } = vi.hoisted(() => ({
  useChannels: vi.fn(),
  actions: { listChannelObservedContacts: vi.fn() },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useChannels,
  useWorkspaceActions: () => actions,
}));

const { ScheduledTaskDeliveryFields } = await import(
  './ScheduledTaskDeliveryFields'
);
const { I18nProvider } = await import('../../i18n');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const configuredTarget = {
  type: 'chat' as const,
  id: 'default',
  label: 'Configured DingTalk group',
};
const webhookType: DaemonChannelTypeDescriptor = {
  type: 'dingtalk-webhook',
  displayName: 'DingTalk webhook',
  manageable: true,
  fields: [],
  outboundOnly: true,
  defaultDeliveryTarget: configuredTarget,
};
const instances = {
  'webhook-bot': { config: { type: 'dingtalk-webhook' } },
  'app-bot': { config: { type: 'dingtalk' } },
};
const configuredDelivery: DaemonChannelDelivery = {
  kind: 'channel',
  target: { channelName: 'webhook-bot', type: 'chat', id: 'default' },
};

describe('ScheduledTaskDeliveryFields configured destinations', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();
  let catalog: DaemonChannelTypeDescriptor[];

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    catalog = [webhookType];
    useChannels.mockImplementation(() => ({
      data: { catalog, snapshot: { instances } },
      catalog,
      channels: instances,
      loading: false,
      error: undefined,
    }));
    actions.listChannelObservedContacts.mockResolvedValue({
      users: [],
      groups: [],
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(
    delivery: DaemonChannelDelivery | null,
    overrides: Partial<ComponentProps<typeof ScheduledTaskDeliveryFields>> = {},
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ScheduledTaskDeliveryFields
            delivery={delivery}
            onChange={onChange}
            available
            observedContactsAvailable
            workspaceId="secondary"
            workspaceCwd="/repo/secondary"
            workspaceMissing={false}
            perRun={false}
            disabled={false}
            {...overrides}
          />
        </I18nProvider>,
      );
    });
  }

  function selectChannel(value: string) {
    const select = container.querySelector<HTMLSelectElement>(
      '#scheduled-task-delivery-channel',
    )!;
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('selects the declared target without requiring or fabricating contacts', async () => {
    await render(null);
    expect(onChange).not.toHaveBeenCalled();
    selectChannel('webhook-bot');
    expect(onChange).toHaveBeenLastCalledWith(configuredDelivery);
    await render(configuredDelivery);
    expect(container.textContent).toContain(configuredTarget.label);
    expect(container.querySelector('#scheduled-task-delivery-id')).toBeNull();
    expect(container.querySelector('#scheduled-task-delivery-type')).toBeNull();
    expect(
      container.querySelector('#scheduled-task-delivery-suggestion'),
    ).toBeNull();
    expect(actions.listChannelObservedContacts).not.toHaveBeenCalled();
    expect(useChannels).toHaveBeenLastCalledWith({
      workspaceCwd: '/repo/secondary',
      enabled: true,
      autoLoad: true,
    });
  });

  it('round-trips a saved configured target without updating it', async () => {
    await render(configuredDelivery);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('webhook-bot');
    expect(container.textContent).toContain('default');
    selectChannel('');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('waits for the catalog before discovering contacts for a saved target', async () => {
    useChannels.mockReturnValue({
      data: undefined,
      catalog: [],
      channels: {},
      loading: true,
      error: undefined,
    });
    await render(configuredDelivery);
    expect(actions.listChannelObservedContacts).not.toHaveBeenCalled();
    useChannels.mockReturnValue({
      data: { catalog, snapshot: { instances } },
      catalog,
      channels: instances,
      loading: false,
      error: undefined,
    });
    await render(configuredDelivery);
    expect(actions.listChannelObservedContacts).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserves an unsupported saved ID until the user explicitly selects the configured destination', async () => {
    const saved: DaemonChannelDelivery = {
      kind: 'channel',
      target: { channelName: 'webhook-bot', type: 'user', id: ' old-id ' },
    };
    await render(saved);
    expect(onChange).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>('#scheduled-task-delivery-id')
        ?.value,
    ).toBe(' old-id ');
    expect(
      container.querySelector<HTMLSelectElement>(
        '#scheduled-task-delivery-type',
      )?.value,
    ).toBe('user');
    const button = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Use configured destination',
    )!;
    expect(button).toBeDefined();
    act(() => button.click());
    expect(onChange).toHaveBeenLastCalledWith(configuredDelivery);
    await render(configuredDelivery);
    expect(container.querySelector('#scheduled-task-delivery-id')).toBeNull();
  });

  it('does not rewrite a target when catalog metadata arrives after the draft', async () => {
    catalog = [];
    const saved: DaemonChannelDelivery = {
      kind: 'channel',
      target: { channelName: 'webhook-bot', type: 'chat', id: 'legacy-id' },
    };
    await render(saved);
    catalog = [webhookType];
    await render(saved);
    expect(onChange).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>('#scheduled-task-delivery-id')
        ?.value,
    ).toBe('legacy-id');
    expect(container.textContent).toContain('Use configured destination');
  });

  it('keeps manual targets for older catalogs and application bots', async () => {
    catalog = [];
    await render(null);
    selectChannel('webhook-bot');
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'channel',
      target: { channelName: 'webhook-bot', type: 'chat', id: '' },
    });
    catalog = [webhookType];
    await render(configuredDelivery);
    selectChannel('app-bot');
    const manualDelivery: DaemonChannelDelivery = {
      kind: 'channel',
      target: { channelName: 'app-bot', type: 'chat', id: '' },
    };
    expect(onChange).toHaveBeenLastCalledWith(manualDelivery);
    await render(manualDelivery);
    expect(
      container.querySelector('#scheduled-task-delivery-id'),
    ).not.toBeNull();
    expect(actions.listChannelObservedContacts).toHaveBeenCalledWith(
      'secondary',
    );
  });

  it('keeps configured target repair disabled when delivery changes are unavailable', async () => {
    await render(
      {
        ...configuredDelivery,
        target: { ...configuredDelivery.target, id: 'wrong-id' },
      },
      { disabled: true },
    );
    const button = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'Use configured destination',
    )!;
    expect(button.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
