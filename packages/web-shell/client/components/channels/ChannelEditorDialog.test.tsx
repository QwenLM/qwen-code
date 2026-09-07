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
  DaemonWorkspaceCapability,
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
      key: 'sessionScope',
      // Descriptor labels intentionally differ from the i18n values so a
      // missing i18n key surfaces the untranslated fallback instead of
      // passing the copy assertions below.
      label: 'Session scope (descriptor)',
      kind: 'enum',
      required: true,
      default: 'user',
      options: [
        { value: 'user', label: 'Descriptor per user' },
        { value: 'thread', label: 'Descriptor per thread' },
        { value: 'chat_thread', label: 'Descriptor per chat' },
        { value: 'single', label: 'Descriptor shared' },
      ],
    },
    {
      key: 'interactiveCards',
      label: 'Interactive Cards',
      kind: 'object',
      properties: [{ key: 'enabled', label: 'Enabled', kind: 'boolean' }],
    },
  ],
};

const DINGTALK_WITH_ACCESS: DaemonChannelTypeDescriptor = {
  ...DINGTALK,
  fields: [
    ...DINGTALK.fields,
    {
      key: 'senderPolicy',
      label: 'Sender Policy',
      kind: 'enum',
      required: true,
      default: 'allowlist',
      options: [
        { value: 'pairing', label: 'Pairing' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'open', label: 'Open' },
      ],
    },
    {
      key: 'allowedUsers',
      label: 'Allowed Users',
      kind: 'string-list',
    },
    {
      key: 'groupPolicy',
      label: 'Group Policy',
      kind: 'enum',
      required: true,
      default: 'disabled',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'open', label: 'Open' },
      ],
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

const WORKSPACES: DaemonWorkspaceCapability[] = [
  {
    id: 'primary',
    cwd: '/workspace/main',
    displayName: 'Main repo',
    primary: true,
    trusted: true,
  },
  {
    id: 'secondary',
    cwd: '/workspace/secondary',
    displayName: 'Secondary repo',
    primary: false,
    trusted: true,
  },
];

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
          workspaces={WORKSPACES}
          workspaceCwd="/workspace/main"
          onWorkspaceChange={vi.fn()}
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

function fieldByLabel(label: string): HTMLElement | null {
  const labels = Array.from(document.querySelectorAll('label'));
  const match = labels.find((item) => item.textContent?.includes(label));
  return match?.htmlFor
    ? document.querySelector<HTMLElement>(`#${match.htmlFor}`)
    : null;
}

async function selectOption(label: string, optionLabel: string) {
  const trigger = fieldByLabel(label);
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((item) => item.textContent?.trim() === optionLabel);
  expect(option).toBeDefined();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function chooseRadioOption(optionLabel: string) {
  const option = Array.from(document.querySelectorAll('label')).find(
    (label) => label.textContent?.trim() === optionLabel,
  );
  expect(option).not.toBeNull();
  await act(async () => {
    option!.click();
  });
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
  it('defaults to the primary workspace and allows a registered workspace', async () => {
    const onWorkspaceChange = vi.fn();
    await renderDialog({ onWorkspaceChange });

    expect(fieldByLabel('Workspace')?.textContent).toContain('Main repo');
    expect(fieldByLabel('Workspace')?.textContent).toContain('Primary');

    await selectOption('Workspace', 'Secondary repo');

    expect(onWorkspaceChange).toHaveBeenCalledWith('/workspace/secondary');
  });

  it('offers the legacy thread scope only for an existing legacy Channel', async () => {
    await renderDialog();

    expect(document.body.textContent).not.toContain('By thread (legacy)');

    await renderDialog({ instance: INSTANCE });

    expect(document.body.textContent).not.toContain('By thread (legacy)');

    await renderDialog({
      instance: {
        ...INSTANCE,
        config: { ...INSTANCE.config, sessionScope: 'thread' },
      },
    });

    expect(document.body.textContent).toContain('By thread (legacy)');
    expect(
      document
        .querySelector('[role="radio"][value="thread"]')
        ?.getAttribute('data-state'),
    ).toBe('checked');

    const defaultThreadDescriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: DINGTALK.fields.map((field) =>
        field.key === 'sessionScope' ? { ...field, default: 'thread' } : field,
      ),
    };
    const defaultThreadInstance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: { ...INSTANCE.config },
    };
    delete defaultThreadInstance.config.sessionScope;
    await renderDialog({
      descriptor: defaultThreadDescriptor,
      instance: defaultThreadInstance,
    });

    expect(document.body.textContent).toContain('By thread (legacy)');
    expect(
      document
        .querySelector('[role="radio"][value="thread"]')
        ?.getAttribute('data-state'),
    ).toBe('checked');
  });

  it('localizes named tasks and switches their session scope to user', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: [
        ...DINGTALK.fields,
        {
          key: 'multiSession',
          label: 'Named Sessions (descriptor)',
          description: 'Descriptor description',
          kind: 'boolean',
        },
      ],
    };
    await renderDialog({ descriptor });

    expect(document.body.textContent).toContain('Named tasks');
    expect(document.body.textContent).toContain(
      'Keep a separate owner-scoped catalog of named tasks',
    );
    await chooseRadioOption('By chat or thread');
    const toggle = fieldByLabel('Named tasks');
    expect(toggle).not.toBeNull();
    await act(async () => toggle!.click());

    expect(
      document
        .querySelector('[role="radio"][value="user"]')
        ?.getAttribute('data-state'),
    ).toBe('checked');
  });

  it('clears validation errors when switching workspaces', async () => {
    await renderDialog({ existingNames: ['duplicate'] });

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'duplicate');
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => save?.click());
    expect(document.body.textContent).toContain(
      'A Channel with this name already exists.',
    );
    expect(inputByLabel('Instance name')?.getAttribute('aria-invalid')).toBe(
      'true',
    );

    await renderDialog({
      existingNames: [],
      workspaceCwd: '/workspace/secondary',
    });

    expect(document.body.textContent).not.toContain(
      'A Channel with this name already exists.',
    );
    expect(inputByLabel('Instance name')?.getAttribute('aria-invalid')).toBe(
      'false',
    );
  });

  it('clears submit errors when switching workspaces', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Revision conflict.'));
    await renderDialog({ onSave });

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'release-bot');
      setInputValue(inputByLabel('Client ID')!, 'ding-client-id');
      setInputValue(inputByLabel('Client Secret')!, 'ding-client-secret');
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => save?.click());
    expect(document.body.textContent).toContain('Revision conflict.');
    expect(document.body.textContent).toContain('Reload latest');

    await renderDialog({ workspaceCwd: '/workspace/secondary' });

    expect(document.body.textContent).not.toContain('Revision conflict.');
    expect(document.body.textContent).not.toContain('Reload latest');
  });

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
    expect(fieldByLabel('Workspace')).toHaveProperty('disabled', true);

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

  it('shows the effective session scope in its own section', async () => {
    await renderDialog({ instance: INSTANCE });

    expect(document.body.textContent).toContain('Conversation management');
    expect(document.body.textContent).toContain('Conversation isolation');
    expect(document.body.textContent).toContain('By user');
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
        sessionScope: 'user',
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

  it('can be dismissed while a save finishes in the background', async () => {
    let finishSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    await renderDialog({ onSave, onOpenChange });

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'release-bot');
      setInputValue(inputByLabel('Client ID')!, 'ding-client-id');
      setInputValue(inputByLabel('Client Secret')!, 'ding-client-secret');
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
    expect((fieldByLabel('Workspace') as HTMLButtonElement).disabled).toBe(
      true,
    );
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel',
    );

    expect(cancel?.disabled).toBe(false);
    await act(async () => {
      cancel?.click();
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => finishSave());
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('explains reserved group IDs under the allowlist field', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: DINGTALK_WITH_ACCESS, onSave });

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'release-bot');
      setInputValue(inputByLabel('Client ID')!, 'ding-client-id');
      setInputValue(inputByLabel('Client Secret')!, 'ding-client-secret');
    });
    await selectOption('Group policy', 'Allowlist');
    await act(async () => {
      setInputValue(inputByLabel('Allowed group IDs')!, '__proto__');
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(
      inputByLabel('Allowed group IDs')?.getAttribute('aria-invalid'),
    ).toBe('true');
    expect(document.body.textContent).toContain(
      'Enter a group ID other than __proto__, constructor, or prototype.',
    );
    expect(document.body.textContent).not.toContain(
      'Choose a different instance name.',
    );
  });

  it('submits sender and group allowlists in their runtime config shapes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: DINGTALK_WITH_ACCESS, onSave });

    const name = inputByLabel('Instance name');
    const clientId = inputByLabel('Client ID');
    const clientSecret = inputByLabel('Client Secret');
    await act(async () => {
      setInputValue(name!, 'release-bot');
      setInputValue(clientId!, 'ding-client-id');
      setInputValue(clientSecret!, 'ding-client-secret');
    });

    const allowedUsers = inputByLabel('Allowed user IDs');
    expect(allowedUsers).not.toBeNull();
    await selectOption('Direct message policy', 'Pairing');
    expect(inputByLabel('Allowed user IDs')).toBeNull();
    await selectOption('Direct message policy', 'Allowlist');
    await act(async () => {
      setInputValue(inputByLabel('Allowed user IDs')!, 'staff-a, staff-b');
    });

    await selectOption('Group policy', 'Allowlist');
    const allowedGroups = inputByLabel('Allowed group IDs');
    expect(allowedGroups).not.toBeNull();
    await act(async () => {
      setInputValue(allowedGroups!, 'group-a, group-b');
    });

    const dialogText = document.body.textContent ?? '';
    expect(dialogText).toContain('Conversation management');
    expect(dialogText.indexOf('Conversation management')).toBeLessThan(
      dialogText.indexOf('Access control'),
    );
    expect(dialogText).toContain(
      "The same user's messages continue in one conversation; users stay isolated from each other.",
    );
    await chooseRadioOption('By chat or thread');
    expect(document.body.textContent).toContain(
      'Messages in the same group or topic share one conversation; best for collaboration.',
    );

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
        senderPolicy: 'allowlist',
        allowedUsers: ['staff-a', 'staff-b'],
        groupPolicy: 'allowlist',
        sessionScope: 'chat_thread',
        groups: { 'group-a': {}, 'group-b': {} },
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
        sessionScope: 'user',
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
