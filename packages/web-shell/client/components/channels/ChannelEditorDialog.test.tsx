/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DINGTALK: DaemonChannelTypeDescriptor = {
  type: 'dingtalk',
  displayName: 'DingTalk',
  manageable: true,
  fields: [
    {
      key: 'clientId',
      label: 'Client ID',
      kind: 'string',
      required: true,
    },
    {
      key: 'clientSecret',
      label: 'Client Secret',
      kind: 'secret',
      required: true,
    },
    {
      key: 'interactiveCards',
      label: 'Interactive Cards',
      kind: 'object',
      properties: [{ key: 'enabled', label: 'Enabled', kind: 'boolean' }],
    },
  ],
};

const OPTIONAL_SECRET: DaemonChannelTypeDescriptor = {
  ...DINGTALK,
  fields: DINGTALK.fields.map((field) =>
    field.key === 'clientSecret' ? { ...field, required: false } : field,
  ),
};

const GROUP_POLICY_DESCRIPTOR: DaemonChannelTypeDescriptor = {
  type: 'github',
  displayName: 'GitHub',
  manageable: true,
  fields: [
    ...DINGTALK.fields,
    {
      key: 'groupPolicy',
      label: 'Group Policy',
      kind: 'enum',
      required: false,
      options: [
        { value: 'open', label: 'Open' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
  ],
};

const GITHUB_LOCAL_GH: DaemonChannelTypeDescriptor = {
  type: 'github',
  displayName: 'GitHub',
  manageable: true,
  fields: [
    {
      key: 'token',
      label: 'Personal Access Token',
      kind: 'secret',
    },
    {
      key: 'useLocalGh',
      label: 'Use Local GitHub CLI Authentication',
      kind: 'boolean',
    },
  ],
};

const EXCLUSIVE_MINIMUM: DaemonChannelTypeDescriptor = {
  type: 'example',
  displayName: 'Example',
  manageable: true,
  fields: [
    {
      key: 'timeoutMs',
      label: 'Timeout (ms)',
      kind: 'number',
      exclusiveMinimum: 0,
    },
  ],
};

const INSTANCE: DaemonChannelInstanceSnapshot = {
  name: 'release-bot',
  config: {
    type: 'dingtalk',
    clientId: 'stored-id',
    senderPolicy: 'open',
  },
  secrets: {
    clientSecret: { present: true, source: 'environment' },
  },
  startsWithServe: false,
  runtime: { state: 'stopped' },
};

const PAIRING_INSTANCE: DaemonChannelInstanceSnapshot = {
  ...INSTANCE,
  config: {
    ...INSTANCE.config,
    senderPolicy: 'pairing',
    allowedUsers: ['configured-user'],
  },
};

const { ChannelEditorDialog } = await import('./ChannelEditorDialog');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

async function renderDialog(
  props: Partial<React.ComponentProps<typeof ChannelEditorDialog>> = {},
) {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <ChannelEditorDialog
          open
          descriptor={DINGTALK}
          expectedRevision="revision-1"
          existingNames={[]}
          onOpenChange={vi.fn()}
          onSave={vi.fn().mockResolvedValue(undefined)}
          onReload={vi.fn().mockResolvedValue(undefined)}
          listPairingRequests={vi.fn().mockResolvedValue({ requests: [] })}
          approvePairingRequest={vi.fn()}
          listPairingApprovals={vi.fn().mockResolvedValue({ senderIds: [] })}
          revokePairingApproval={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  });
}

function inputByLabel(label: string): HTMLInputElement | null {
  const labels = Array.from(document.querySelectorAll('label'));
  const match = labels.find((item) => item.textContent?.includes(label));
  const id = match?.htmlFor;
  return id ? document.querySelector<HTMLInputElement>(`#${id}`) : null;
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('ChannelEditorDialog', () => {
  it('does not render object metadata as a text field', async () => {
    await renderDialog();

    expect(inputByLabel('Interactive Cards')).toBeNull();
  });

  it('preserves a stored secret until Replace is explicitly selected', async () => {
    await renderDialog({ instance: INSTANCE });

    expect(document.body.textContent).toContain('Edit DingTalk');
    expect(document.body.textContent).toContain('Stored in environment');
    expect(document.body.textContent).not.toContain('Clear');
    expect(inputByLabel('Client Secret')).toBeNull();

    const replace = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Replace',
    );
    await act(async () => {
      replace?.click();
    });

    expect(inputByLabel('Client Secret')).not.toBeNull();
  });

  it('offers Clear for an optional stored secret', async () => {
    await renderDialog({ descriptor: OPTIONAL_SECRET, instance: INSTANCE });

    const clear = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Clear',
    );
    expect(clear).toBeDefined();
  });

  it('submits a new instance with typed fields and the current revision', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ onSave });

    const name = inputByLabel('Instance name');
    const clientId = inputByLabel('Client ID');
    const clientSecret = inputByLabel('Client Secret');
    expect(name).not.toBeNull();
    expect(clientId).not.toBeNull();
    expect(clientSecret).not.toBeNull();

    await act(async () => {
      setInputValue(name!, 'release-bot');
      setInputValue(clientId!, 'ding-client-id');
      setInputValue(clientSecret!, 'ding-client-secret');
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith('release-bot', {
      expectedRevision: 'revision-1',
      config: {
        type: 'dingtalk',
        clientId: 'ding-client-id',
        senderPolicy: 'pairing',
      },
      secrets: {
        clientSecret: {
          operation: 'replace',
          value: 'ding-client-secret',
        },
      },
    });
  });

  it('explains that pairing requests appear after a new Channel is saved', async () => {
    await renderDialog();

    expect(document.body.textContent).toContain('Save pairing mode first');
    expect(document.body.textContent).toContain(
      'Pending requests will appear here after this Channel is saved in pairing mode.',
    );
  });

  it('keeps the dialog open and offers a reload after a stale write', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(
        new Error('Channel settings changed; reload before trying again.'),
      );
    await renderDialog({ instance: INSTANCE, onSave });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(document.body.textContent).toContain(
      'Channel settings changed; reload before trying again.',
    );
    expect(document.body.textContent).toContain('Reload latest');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps the dialog open when reloading the latest configuration fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Revision conflict.'));
    const onReload = vi
      .fn()
      .mockRejectedValue(new Error('Reload is temporarily unavailable.'));
    await renderDialog({ instance: INSTANCE, onSave, onReload });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
    const reload = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Reload latest',
    );
    await act(async () => {
      reload?.click();
    });

    expect(document.body.textContent).toContain(
      'Reload is temporarily unavailable.',
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('shows the configured allowlist for a pairing Channel and hides it without one', async () => {
    await renderDialog({ instance: PAIRING_INSTANCE });

    expect(document.body.textContent).toContain('Configured allowlist');
    expect(document.body.textContent).toContain('configured-user');
  });

  it('saves the local GitHub CLI opt-in when the switch is toggled', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: GITHUB_LOCAL_GH, onSave });

    const name = inputByLabel('Instance name');
    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(name).not.toBeNull();
    expect(toggle).not.toBeNull();

    await act(async () => {
      setInputValue(name!, 'github-bot');
      toggle!.click();
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith('github-bot', {
      expectedRevision: 'revision-1',
      config: {
        type: 'github',
        useLocalGh: true,
        senderPolicy: 'pairing',
      },
      secrets: { token: { operation: 'clear' } },
    });
  });

  it('does not show the allowlist alert when no users are configured', async () => {
    const pairingNoAllowlist: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: { ...INSTANCE.config, senderPolicy: 'pairing' },
    };
    await renderDialog({ instance: pairingNoAllowlist });

    expect(document.body.textContent).toContain('Pairing approvals');
    expect(document.body.textContent).not.toContain('Configured allowlist');
  });

  it('re-sends the stored object config when editing an existing instance', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: {
        ...INSTANCE.config,
        interactiveCards: { enabled: true, statusCard: { enabled: true } },
      },
    };
    await renderDialog({ instance, onSave });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith('release-bot', {
      expectedRevision: 'revision-1',
      config: {
        type: 'dingtalk',
        clientId: 'stored-id',
        senderPolicy: 'open',
        interactiveCards: { enabled: true, statusCard: { enabled: true } },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });
  });

  it('shows the out-of-range message for a number at the exclusive minimum', async () => {
    await renderDialog({ descriptor: EXCLUSIVE_MINIMUM });

    const name = inputByLabel('Instance name');
    const timeoutMs = inputByLabel('Timeout (ms)');
    expect(name).not.toBeNull();
    expect(timeoutMs).not.toBeNull();
    await act(async () => {
      setInputValue(name!, 'example-bot');
      setInputValue(timeoutMs!, '0');
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(document.body.textContent).toContain(
      'Enter a number greater than 0.',
    );
  });

  it('shows pairing affordance from a descriptor-driven groupPolicy draft', async () => {
    const groupPolicyInstance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: {
        ...INSTANCE.config,
        senderPolicy: 'open',
        groupPolicy: 'open',
      },
    };
    await renderDialog({
      descriptor: GROUP_POLICY_DESCRIPTOR,
      instance: groupPolicyInstance,
    });

    expect(document.body.textContent).not.toContain('Save pairing mode first');

    const trigger = inputByLabel('Group Policy');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.trim() === 'Pairing');
    expect(option).toBeDefined();
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Save pairing mode first');
  });

  it('shows pairing management when only group pairing is enabled', async () => {
    const groupPairingInstance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: {
        ...INSTANCE.config,
        senderPolicy: 'open',
        groupPolicy: 'pairing',
      },
    };
    const listPairingRequests = vi.fn().mockResolvedValue({ requests: [] });

    await renderDialog({
      instance: groupPairingInstance,
      listPairingRequests,
    });

    expect(document.body.textContent).toContain('Pairing approvals');
    expect(listPairingRequests).toHaveBeenCalledWith('release-bot');
  });
});
