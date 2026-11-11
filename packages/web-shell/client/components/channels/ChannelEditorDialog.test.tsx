/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { plugin as emailPlugin } from '@qwen-code/channel-email';

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
      key: 'privatePolicy',
      label: 'Private Policy',
      kind: 'enum',
      required: true,
      default: 'allowlist',
      options: [
        { value: 'disabled', label: 'Disabled' },
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

// Same field keys as the real GitHub descriptor; labels/descriptions
// intentionally differ from the i18n values so a missing FIELD_LABEL_KEYS
// entry or i18n key surfaces the untranslated descriptor fallback.
const GITHUB_BOUND: DaemonChannelTypeDescriptor = {
  type: 'github',
  displayName: 'GitHub',
  manageable: true,
  fields: [
    { key: 'token', label: 'Token (descriptor)', kind: 'secret' },
    {
      key: 'deliverToBoundSessions',
      label: 'Bound sessions (descriptor)',
      kind: 'boolean',
      default: 'false',
      description: 'Descriptor description for bound sessions',
    },
    {
      key: 'requireBoundWatch',
      label: 'Bound watch gate (descriptor)',
      kind: 'boolean',
      default: 'false',
      description: 'Descriptor description for the bound watch gate',
    },
    {
      key: 'prWatchEvents',
      label: 'Watch events (descriptor)',
      kind: 'string-list',
      description: 'Descriptor description for watch events',
      options: [
        { value: 'ci_failure', label: 'ci_failure' },
        { value: 'merge_conflict', label: 'merge_conflict' },
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

// Mirrors the registry-composed GitHub catalog: the plugin fields plus the
// injected privatePolicy/allowedUsers that the adapter never reads.
const GITHUB_CONFIGURED: DaemonChannelTypeDescriptor = {
  type: 'github',
  displayName: 'GitHub',
  manageable: true,
  fields: [
    {
      key: 'token',
      label: 'Personal Access Token',
      kind: 'secret',
      envResolvable: true,
    },
    {
      key: 'useLocalGh',
      label: 'Use Local GitHub CLI Authentication',
      kind: 'boolean',
    },
    {
      key: 'baseUrl',
      label: 'Base URL',
      kind: 'string',
      envResolvable: true,
    },
    {
      key: 'groupPolicy',
      label: 'Group Policy',
      kind: 'enum',
      required: true,
      default: 'open',
      options: [
        { value: 'open', label: 'Open' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
    {
      key: 'reasonFilter',
      label: 'Reason Filter',
      kind: 'string-list',
      options: [
        { value: 'mention', label: 'mention' },
        { value: 'review_requested', label: 'review_requested' },
        { value: 'ci_activity', label: 'ci_activity' },
        { value: 'comment', label: 'comment' },
      ],
    },
    {
      key: 'privatePolicy',
      label: 'Private Policy',
      kind: 'enum',
      required: true,
      default: 'pairing',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'open', label: 'Open' },
      ],
    },
    {
      key: 'allowedUsers',
      label: 'Allowed Users',
      kind: 'string-list',
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

// The shared `instructions` control the channel registry injects into every
// manageable channel (channel-registry.ts), plus a plain string sibling. The
// descriptor label and description for `instructions` intentionally differ from
// the i18n values so a missing i18n key surfaces the untranslated fallback
// instead of passing the assertions below.
const MULTILINE_INSTRUCTIONS: DaemonChannelTypeDescriptor = {
  type: 'example',
  displayName: 'Example',
  manageable: true,
  fields: [
    {
      key: 'instructions',
      label: 'Session instructions (descriptor)',
      description: 'DESCRIPTOR FALLBACK COPY',
      kind: 'string',
      multiline: true,
    },
    {
      key: 'apiEndpoint',
      label: 'API endpoint (descriptor)',
      kind: 'string',
    },
  ],
};

// A non-GitHub channel carrying the connection and routing field keys the
// section split keys on, so the split is not pinned to the GitHub editor.
const GITLAB_ROUTING: DaemonChannelTypeDescriptor = {
  type: 'gitlab',
  displayName: 'GitLab',
  manageable: true,
  fields: [
    {
      key: 'token',
      label: 'Personal Access Token',
      kind: 'secret',
    },
    {
      key: 'baseUrl',
      label: 'Instance URL',
      kind: 'string',
    },
    {
      key: 'defaultMessageRoute',
      label: 'Default Message Route',
      kind: 'string',
    },
    {
      key: 'messageRoutes',
      label: 'Message Routes',
      kind: 'record',
    },
  ],
};

const INSTANCE: DaemonChannelInstanceSnapshot = {
  name: 'release-bot',
  config: {
    type: 'dingtalk',
    clientId: 'stored-id',
    privatePolicy: 'open',
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
    privatePolicy: 'pairing',
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
const { I18nProvider, getTranslator } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

async function renderDialog({
  language = 'en',
  ...props
}: Partial<React.ComponentProps<typeof ChannelEditorDialog>> & {
  language?: 'en' | 'zh-CN';
} = {}) {
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
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

// Advanced fields unmount while the panel is collapsed; tests that exercise
// them expand it first. A panel that auto-opened on configured values is left
// alone so the helper never toggles it shut.
async function expandAdvancedSettings(label = 'Advanced settings') {
  const trigger = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent?.includes(label),
  );
  expect(trigger).toBeDefined();
  if (trigger!.getAttribute('data-state') === 'open') return;
  await act(async () => {
    trigger!.click();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function sectionHeadingOf(element: HTMLElement | null): string | null {
  const heading = element
    ?.closest('section')
    ?.querySelector('h3')
    ?.textContent?.trim();
  return heading ?? null;
}

// Record fields render their label without targeting a control, so resolve the
// section from the label text instead of the control id.
function sectionHeadingOfLabel(labelText: string): string | null {
  const label = Array.from(document.querySelectorAll('label')).find((item) =>
    item.textContent?.includes(labelText),
  );
  const heading = label?.closest('section')?.querySelector('h3');
  return heading?.textContent?.trim() ?? null;
}

// FieldShell renders the field description as the first <p> inside the field
// wrapper that also holds the control, after the label header.
function descriptionOf(element: HTMLElement | null): string {
  return element?.parentElement?.querySelector('p')?.textContent?.trim() ?? '';
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
  it('shows the default output mode for an existing unconfigured channel and saves a changed mode', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: [
        ...DINGTALK.fields,
        {
          key: 'outputMode',
          label: 'Output Mode',
          kind: 'enum',
          default: 'per_turn',
          options: [
            { value: 'per_task', label: 'Per task' },
            { value: 'per_response', label: 'Per response' },
            { value: 'per_turn', label: 'Per turn (default)' },
          ],
        },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor, instance: INSTANCE, onSave });

    expect(fieldByLabel('Output Mode')?.textContent).toBe('Per turn (default)');
    expect(sectionHeadingOf(fieldByLabel('Output Mode'))).toBe(
      'Conversation management',
    );
    await selectOption('Output Mode', 'Per task');
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => save?.click());

    expect(onSave).toHaveBeenCalledWith(
      'release-bot',
      expect.objectContaining({
        config: expect.objectContaining({ outputMode: 'per_task' }),
      }),
    );
    await renderDialog({
      descriptor,
      instance: { ...INSTANCE },
      language: 'zh-CN',
    });
    expect(fieldByLabel('输出模式')?.textContent).toBe('按轮（默认）');
    expect(sectionHeadingOf(fieldByLabel('输出模式'))).toBe('会话管理');
    expect(document.body.textContent).toContain('默认按轮输出：主回复独立结束');
    await selectOption('输出模式', '按任务');
    expect(fieldByLabel('输出模式')?.textContent).toBe('按任务');
    await selectOption('输出模式', '按回复');
    expect(fieldByLabel('输出模式')?.textContent).toBe('按回复');
    await selectOption('输出模式', '按轮（默认）');
    expect(fieldByLabel('输出模式')?.textContent).toBe('按轮（默认）');
  });

  it('edits private access with four policies while preserving deprecated keys', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK_WITH_ACCESS,
      fields: DINGTALK_WITH_ACCESS.fields.filter((field) =>
        ['privatePolicy', 'groupPolicy', 'allowedUsers'].includes(field.key),
      ),
      type: 'dws',
      displayName: 'DingTalk Workspace',
    };
    const instance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      name: 'dws-bot',
      config: {
        type: 'dws',
        senderPolicy: 'open',
        dmPolicy: 'disabled',
        groupPolicy: 'open',
      },
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor, instance, onSave });
    expect(fieldByLabel('Direct message policy')?.textContent).toContain(
      'Disabled',
    );
    expect(fieldByLabel('Direct message access')).toBeNull();
    await selectOption('Direct message policy', 'Pairing');
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => save!.click());
    expect(onSave).toHaveBeenCalledWith(
      'dws-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          senderPolicy: 'open',
          dmPolicy: 'disabled',
          privatePolicy: 'pairing',
          groupPolicy: 'open',
        }),
      }),
    );
  });

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
    await expandAdvancedSettings();

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

  it('renders a multiline string field as a textarea and leaves a plain one as an input', async () => {
    await renderDialog({ descriptor: MULTILINE_INSTRUCTIONS });
    await expandAdvancedSettings();

    const instructions = fieldByLabel('Instructions');
    const endpoint = fieldByLabel('API endpoint (descriptor)');

    expect(instructions?.tagName).toBe('TEXTAREA');
    expect(endpoint?.tagName).toBe('INPUT');
  });

  it('files the shared instructions control under advanced settings', async () => {
    await renderDialog({ descriptor: MULTILINE_INSTRUCTIONS });
    await expandAdvancedSettings();

    // `instructions` is rarely changed tuning: it lives in the advanced
    // disclosure panel rather than the catch-all credentials panel, while a
    // plain credential string stays in Credentials.
    const panel = fieldByLabel('Instructions')?.closest(
      '[data-slot="collapsible"]',
    );
    expect(panel?.textContent).toContain('Advanced settings');
    expect(sectionHeadingOf(fieldByLabel('API endpoint (descriptor)'))).toBe(
      'Credentials',
    );
  });

  it('renders the localized instructions copy above the textarea instead of the descriptor literal', async () => {
    await renderDialog({ descriptor: MULTILINE_INSTRUCTIONS });
    await expandAdvancedSettings();

    // `instructions` is the only multiline field in the fixture, so the single
    // textarea anchors the field. fieldDescription resolves
    // `${labelKey}.description` and returns the i18n value whenever the key
    // translates, so this — not the registry literal the catalog serves — is
    // what an operator reads. It is also the only place the replace-not-append
    // behaviour is documented: an additive promise would have a DingTalk
    // operator save over the default identity block that DingtalkAdapter.ts
    // installs only when config.instructions is falsy.
    const description = descriptionOf(document.querySelector('textarea'));
    expect(description).toContain('replace their own default guidance');
    expect(description).not.toContain('DESCRIPTOR FALLBACK COPY');
  });

  it('renders the bound-session fields with translated EN labels', async () => {
    await renderDialog({ descriptor: GITHUB_BOUND });
    const labels = Array.from(document.querySelectorAll('label')).map(
      (l) => l.textContent ?? '',
    );
    expect(labels.some((t) => t.includes('Deliver To PR-Bound Sessions'))).toBe(
      true,
    );
    expect(
      labels.some((t) =>
        t.includes('Require Active Watch For Review/Verify Sessions'),
      ),
    ).toBe(true);
    expect(labels.some((t) => t.includes('PR Watch Events'))).toBe(true);
    // No descriptor fallback may leak through for these keys.
    expect(labels.some((t) => t.includes('(descriptor)'))).toBe(false);
    // fieldDescription falls back to field.description whenever the
    // `<labelKey>.description` key is missing, so label-only assertions would
    // stay green with the raw descriptor copy rendered under each field.
    expect(document.body.textContent ?? '').not.toContain(
      'Descriptor description',
    );
    expect(
      descriptionOf(fieldByLabel('Deliver To PR-Bound Sessions')),
    ).toContain('instead of a channel-owned session');
    expect(descriptionOf(fieldByLabel('PR Watch Events'))).toContain(
      'Leave empty to disable',
    );
  });

  it('renders the bound-session fields with translated zh-CN labels', async () => {
    await renderDialog({ descriptor: GITHUB_BOUND, language: 'zh-CN' });
    const labels = Array.from(document.querySelectorAll('label')).map(
      (l) => l.textContent ?? '',
    );
    expect(labels.some((t) => t.includes('投递到 PR 绑定会话'))).toBe(true);
    expect(labels.some((t) => t.includes('评审/验证会话须有活跃监视'))).toBe(
      true,
    );
    expect(labels.some((t) => t.includes('PR 状态监视事件'))).toBe(true);
    expect(labels.some((t) => t.includes('(descriptor)'))).toBe(false);
    // With the `.description` keys dropped from BOTH locale maps the
    // translator falls through to field.description, so pin the rendered
    // description copy too — the ZH substrings occur in no other locale.
    expect(document.body.textContent ?? '').not.toContain(
      'Descriptor description',
    );
    expect(descriptionOf(fieldByLabel('投递到 PR 绑定会话'))).toContain(
      '以 prompt 形式投递进该会话，而不是频道自有会话',
    );
    expect(descriptionOf(fieldByLabel('PR 状态监视事件'))).toContain(
      '为绑定 PR 监视的状态转换',
    );
  });

  it('frames both bound-session fields in one panel', async () => {
    await renderDialog({ descriptor: GITHUB_BOUND });

    const delivery = fieldByLabel('Deliver To PR-Bound Sessions');
    const watch = fieldByLabel('PR Watch Events');
    expect(delivery).not.toBeNull();
    expect(watch).not.toBeNull();
    expect(delivery!.closest('section')).toBe(watch!.closest('section'));
    expect(sectionHeadingOf(delivery)).toBe('PR-bound sessions');
  });

  it('disables the watch boxes with an inline hint until delivery is on', async () => {
    await renderDialog({ descriptor: GITHUB_BOUND });

    const boxes = () =>
      Array.from(
        document.querySelectorAll<HTMLInputElement>(
          '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
        ),
      );
    expect(boxes().length).toBeGreaterThan(0);
    expect(boxes().every((box) => box.disabled)).toBe(true);
    // The dimmed-row styling hook must track the gate, not just the input.
    expect(
      boxes().every(
        (box) => box.closest('label')?.getAttribute('data-disabled') === 'true',
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain(
      'Enable "Deliver To PR-Bound Sessions" above to select watch events.',
    );

    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });

    expect(boxes().every((box) => box.disabled)).toBe(false);
    expect(document.body.textContent).not.toContain(
      'above to select watch events.',
    );
  });

  it('shows the disabled hint in zh-CN', async () => {
    await renderDialog({ descriptor: GITHUB_BOUND, language: 'zh-CN' });

    expect(document.body.textContent).toContain(
      '开启上方「投递到 PR 绑定会话」后即可选择监视事件。',
    );
    expect(document.body.textContent).toContain(
      '开启上方「投递到 PR 绑定会话」后即可要求活跃监视。',
    );
  });

  it('disables the watch gate switch with an inline hint until delivery is on', async () => {
    await renderDialog({ descriptor: GITHUB_BOUND });

    const gate = fieldByLabel(
      'Require Active Watch For Review/Verify Sessions',
    ) as HTMLButtonElement;
    expect(gate).not.toBeNull();
    expect(gate.getAttribute('role')).toBe('switch');
    expect(gate.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      'Enable "Deliver To PR-Bound Sessions" above to require an active watch.',
    );
    const describedBy = gate.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      'above to require an active watch',
    );

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[role="switch"]')!
        .click();
    });

    expect(gate.disabled).toBe(false);
    expect(document.body.textContent).not.toContain(
      'above to require an active watch.',
    );
  });

  it('names the delivery dependency when a stored watch gate lacks it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        requireBoundWatch: true,
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance, onSave });

    const gate = fieldByLabel(
      'Require Active Watch For Review/Verify Sessions',
    ) as HTMLButtonElement;
    expect(gate.getAttribute('aria-checked')).toBe('true');
    // A stored true stays clearable while the prerequisite is off.
    expect(gate.disabled).toBe(false);

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).not.toHaveBeenCalled();
    // The gate field's own message — not the prWatchEvents one, which names a
    // control this operator never touched.
    expect(document.body.textContent).toContain(
      'Enable "Deliver To PR-Bound Sessions" to require an active watch.',
    );
    expect(document.body.textContent).not.toContain(
      'to save the selected watch events.',
    );

    // Unticking the gate is itself a remedy: it re-derives the shown error
    // without another Save (a valid draft must not keep a stale alert).
    await act(async () => {
      gate.click();
    });
    expect(gate.getAttribute('aria-checked')).toBe('false');
    // The validation error is gone; the disabled hint (which says "above to
    // require…") legitimately remains while delivery is still off.
    expect(document.body.textContent).not.toContain(
      'Enable "Deliver To PR-Bound Sessions" to require an active watch.',
    );
  });

  it('keeps the gate hint live region mounted before the hint appears', async () => {
    // A live region that enters the DOM already filled is never announced.
    // The region must exist (empty) while delivery is on, then carry the hint
    // when delivery toggles off — the same node throughout.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: { type: 'github', deliverToBoundSessions: true },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });

    const gate = fieldByLabel(
      'Require Active Watch For Review/Verify Sessions',
    ) as HTMLButtonElement;
    const region = Array.from(
      document.querySelectorAll<HTMLElement>('span[aria-live="polite"]'),
    ).find((node) => node.id.endsWith('-requireBoundWatch-disabled-hint'));
    expect(region).toBeDefined();
    expect(region!.textContent).toBe('');

    // Toggle delivery off (the first switch).
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[role="switch"]')!
        .click();
    });
    expect(region!.isConnected).toBe(true);
    expect(region!.textContent).toContain('above to require an active watch');
    expect(gate.disabled).toBe(true);
  });

  it('saves the selected watch events once delivery is enabled', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: GITHUB_BOUND, onSave });

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'github-bot');
      setInputValue(inputByLabel('Personal Access Token')!, 'ghp_test');
      document
        .querySelector<HTMLButtonElement>('button[role="switch"]')!
        .click();
    });
    const box = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
      ),
    ).find((b) => b.closest('label')?.textContent?.includes('ci_failure'));
    expect(box).toBeDefined();
    await act(async () => {
      box!.click();
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'github-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          deliverToBoundSessions: true,
          prWatchEvents: ['ci_failure'],
        }),
      }),
    );
  });

  it('names the delivery dependency when a stored selection lacks it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['ci_failure'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance, onSave });

    const box = document.querySelector<HTMLInputElement>(
      '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
    );
    expect(box!.checked).toBe(true);
    // The stored selection stays clearable even while the gate is closed.
    expect(box!.disabled).toBe(false);

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Enable "Deliver To PR-Bound Sessions" to save the selected watch events.',
    );

    // Following the instruction must retire the instruction: turning the
    // switch on clears the stale dependency error without another Save.
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[role="switch"]')!
        .click();
    });
    expect(document.body.textContent).not.toContain(
      'to save the selected watch events.',
    );
  });

  it('lets a stored selection be cleared while delivery is off', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['ci_failure'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance, onSave });

    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
      ),
    );
    const selected = boxes.find((b) =>
      b.closest('label')?.textContent?.includes('ci_failure'),
    )!;
    expect(selected.checked).toBe(true);
    expect(selected.disabled).toBe(false);
    expect(boxes.filter((b) => b !== selected).every((b) => b.disabled)).toBe(
      true,
    );
    // A clearable stored row keeps the selected styling, not the dimmed one.
    expect(selected.closest('label')?.getAttribute('data-disabled')).toBe(
      'false',
    );
    expect(
      boxes
        .filter((b) => b !== selected)
        .every(
          (b) => b.closest('label')?.getAttribute('data-disabled') === 'true',
        ),
    ).toBe(true);

    await act(async () => {
      selected.click();
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['prWatchEvents']).toBeUndefined();
    expect(request.config['deliverToBoundSessions']).toBe(false);
  });

  it('keeps the invalid-option message when delivery is switched on', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['bogus_event'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );

    // Switching delivery on remedies the dependency, not the unknown value:
    // the higher-precedence invalidOption message must survive.
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[role="switch"]')!
        .click();
    });
    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );
    expect(document.body.textContent).not.toContain(
      'to save the selected watch events.',
    );
  });

  it('clears the dependency message when the last event is unticked', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['ci_failure'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
    expect(document.body.textContent).toContain(
      'to save the selected watch events.',
    );

    // Unticking the last event is the other remedy; the alert must retire
    // without another Save.
    const box = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
      ),
    ).find((b) => b.closest('label')?.textContent?.includes('ci_failure'))!;
    await act(async () => {
      box.click();
    });
    expect(document.body.textContent).not.toContain(
      'to save the selected watch events.',
    );
  });

  it('retires the invalid-option message when the offending value is unticked', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['bogus_event'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });

    await act(async () => {
      (
        Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Save',
        ) as HTMLButtonElement
      ).click();
    });
    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );

    // Unticking the offending value is the remedy the message asks for; it
    // must retire the message without a second Save.
    const bogus = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
      ),
    ).find((b) => b.closest('label')?.textContent?.includes('bogus_event'))!;
    await act(async () => {
      bogus.click();
    });
    expect(document.body.textContent).not.toContain(
      "Remove values that aren't in the allowed list.",
    );
  });

  it('replaces the invalid-option message with the dependency one when a valid event remains', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['ci_failure', 'bogus_event'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });

    await act(async () => {
      (
        Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Save',
        ) as HTMLButtonElement
      ).click();
    });
    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );

    const bogus = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
      ),
    ).find((b) => b.closest('label')?.textContent?.includes('bogus_event'))!;
    await act(async () => {
      bogus.click();
    });
    // The remaining value is allowed, so the invalid-option instruction is
    // gone; the still-unsatisfied dependency takes over the slot.
    expect(document.body.textContent).not.toContain(
      "Remove values that aren't in the allowed list.",
    );
    expect(document.body.textContent).toContain(
      'to save the selected watch events.',
    );
  });

  it('does not surface validation before the first submit', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['ci_failure', 'merge_conflict'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });
    expect(document.querySelectorAll('[role="alert"]').length).toBe(0);

    // A legitimate gated edit must not reveal validation state the operator
    // never submitted; submit stays the only population site.
    const box = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
      ),
    ).find((b) => b.closest('label')?.textContent?.includes('merge_conflict'))!;
    await act(async () => {
      box.click();
    });
    expect(document.querySelectorAll('[role="alert"]').length).toBe(0);
  });

  it('keeps a shown invalid-option message when delivery is switched off', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        deliverToBoundSessions: true,
        prWatchEvents: ['bogus_event'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });
    const clickSave = async () => {
      await act(async () => {
        (
          Array.from(document.querySelectorAll('button')).find(
            (button) => button.textContent?.trim() === 'Save',
          ) as HTMLButtonElement
        ).click();
      });
    };
    const clickSwitch = async () => {
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>('button[role="switch"]')!
          .click();
      });
    };

    await clickSave();
    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );
    // The mirror case: a shown instruction survives the switch moving off
    // (re-derived, not silently dropped), in both directions.
    await clickSwitch();
    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );
    await clickSwitch();
    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );
  });

  it('renders no bound-session panel for channels without the fields', async () => {
    await renderDialog({ descriptor: DINGTALK });
    expect(document.body.textContent).not.toContain('PR-bound sessions');
  });

  it('renders no bound-session panel for channels without the fields (zh-CN)', async () => {
    await renderDialog({ descriptor: DINGTALK, language: 'zh-CN' });
    expect(document.body.textContent).not.toContain('PR 绑定会话');
  });

  it('scrolls a non-advanced watch-events error into view on save', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        prWatchEvents: ['ci_failure'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    // jsdom has no scrollIntoView; stub it so the scroll is observable.
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await renderDialog({ descriptor: GITHUB_BOUND, instance });
      await act(async () => {
        (
          Array.from(document.querySelectorAll('button')).find(
            (button) => button.textContent?.trim() === 'Save',
          ) as HTMLButtonElement
        ).click();
      });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
      const target = scrollIntoView.mock.instances[0] as HTMLElement;
      expect(target.id.endsWith('-prWatchEvents')).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('associates the disabled hint with the checkbox group', async () => {
    await renderDialog({ descriptor: GITHUB_BOUND });

    const group = document.querySelector(
      '[role="group"][aria-label="PR Watch Events"]',
    )!;
    const describedBy = group.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const hint = document.getElementById(describedBy!);
    expect(hint?.textContent).toContain('above to select watch events');
    expect(hint?.getAttribute('aria-live')).toBe('polite');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[role="switch"]')!
        .click();
    });
    expect(group.getAttribute('aria-describedby')).toBeNull();
  });

  it('mounts a stored delivery-on instance with its events enabled', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        deliverToBoundSessions: true,
        prWatchEvents: ['ci_failure'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_BOUND, instance });

    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="PR Watch Events"] input[type="checkbox"]',
      ),
    );
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) => !box.disabled)).toBe(true);
    expect(
      boxes.find((b) =>
        b.closest('label')?.textContent?.includes('ci_failure'),
      )!.checked,
    ).toBe(true);
    expect(document.body.textContent).not.toContain(
      'above to select watch events.',
    );

    // The live region must exist (empty) before the hint appears, and the
    // same node must survive the transition — a region mounted together
    // with its text is exactly what aria-live cannot announce.
    const region = Array.from(
      document.querySelectorAll<HTMLElement>('span[aria-live="polite"]'),
    ).find((node) => node.id.endsWith('-prWatchEvents-disabled-hint'));
    expect(region).toBeDefined();
    expect(region!.textContent).toBe('');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[role="switch"]')!
        .click();
    });
    expect(region!.isConnected).toBe(true);
    expect(region!.textContent).toContain('above to select watch events');
  });

  it('localizes the instructions copy for zh-CN operators', async () => {
    await renderDialog({
      descriptor: MULTILINE_INSTRUCTIONS,
      language: 'zh-CN',
    });
    await expandAdvancedSettings('高级设置');

    // getTranslator resolves `messages[key] ?? EN[key] ?? key`, so an assertion
    // phrased only as "not the raw key", or as an English substring, still
    // passes on the EN fallback once the ZH entry is deleted. `替换` occurs only
    // in the ZH value, so this goes red on that mutation.
    const description = descriptionOf(document.querySelector('textarea'));
    expect(description).toContain('替换');
    expect(description).not.toContain('DESCRIPTOR FALLBACK COPY');
  });

  it('saves a multi-line instructions value with the newline intact', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: MULTILINE_INSTRUCTIONS, onSave });
    await expandAdvancedSettings();

    const instructions = fieldByLabel('Instructions');
    expect(instructions).toBeInstanceOf(HTMLTextAreaElement);

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'release-bot');
      setTextareaValue(
        instructions as HTMLTextAreaElement,
        '  line one\nline two  ',
      );
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    // assignField trims the outer whitespace but must not flatten the
    // embedded newline, or the control cannot carry multi-line guidance.
    expect(onSave).toHaveBeenCalledWith(
      'release-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          instructions: 'line one\nline two',
        }),
      }),
    );
  });

  it('loads a stored multi-line instructions value into the textarea and saves it unchanged', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    // Edit mode: createChannelEditorDraft loads a stored string untrimmed
    // (channel-editor-state.ts:110) while assignField trims on save
    // (channel-editor-state.ts:249), so the fixture carries no outer
    // whitespace and the round trip must be exact. Without the draft value
    // threaded into the Textarea, an operator editing a configured channel
    // sees an empty box and their first keystroke replaces the whole block.
    await renderDialog({
      descriptor: MULTILINE_INSTRUCTIONS,
      instance: {
        ...INSTANCE,
        config: { ...INSTANCE.config, instructions: 'line one\nline two' },
      },
      onSave,
    });

    const instructions = fieldByLabel('Instructions');
    expect(instructions).toBeInstanceOf(HTMLTextAreaElement);
    expect((instructions as HTMLTextAreaElement).value).toBe(
      'line one\nline two',
    );

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'release-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          instructions: 'line one\nline two',
        }),
      }),
    );
  });

  it('renders record entries on demand and filters empty values on save', async () => {
    // The channel validators reject empty template values. The editor keeps
    // an added-but-empty row in the draft so it holds its place, and the save
    // serializer filters empty values regardless. Pin the end-to-end outcome:
    // the cleared key is absent from the upsert config, the untouched sibling
    // survives.
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: [
        ...DINGTALK.fields,
        {
          key: 'boundSessionActions',
          label: 'Bound Session Actions',
          kind: 'record',
          options: [
            {
              value: 'review:watch:head_change',
              label: 'review:watch:head_change',
            },
            { value: 'fix:comment', label: 'fix:comment' },
          ],
        },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor, instance: INSTANCE, onSave });

    // A fresh draft shows the add picker, not one row per descriptor option.
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
    expect(fieldByLabel('Bound Session Actions')).not.toBeNull();
    // This fixture is dingtalk-typed, where the field has no label-key
    // registration, so the generic entry copy applies (the template-worded
    // override is pinned in the github-typed cases below).
    expect(document.body.textContent).toContain('No entries configured yet.');

    // Record row ids embed the option key (colons included), which is not a
    // valid CSS selector — resolve through getElementById, not #id.
    const recordTextarea = (labelText: string): HTMLTextAreaElement | null => {
      const label = Array.from(document.querySelectorAll('label')).find(
        (item) => item.textContent?.includes(labelText),
      );
      const id = label?.htmlFor;
      return id
        ? (document.getElementById(id) as HTMLTextAreaElement | null)
        : null;
    };

    await selectOption('Bound Session Actions', 'review:watch:head_change');
    await selectOption('Bound Session Actions', 'fix:comment');
    const reviewRow = recordTextarea('review:watch:head_change');
    const fixRow = recordTextarea('fix:comment');
    expect(reviewRow).toBeInstanceOf(HTMLTextAreaElement);
    expect(fixRow).toBeInstanceOf(HTMLTextAreaElement);

    await act(async () => {
      setTextareaValue(reviewRow!, 'Run /review %pr%');
      setTextareaValue(fixRow!, 'Address the comments');
    });
    await act(async () => {
      setTextareaValue(reviewRow!, '');
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'release-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          boundSessionActions: { 'fix:comment': 'Address the comments' },
        }),
      }),
    );
  });

  it('removes a record entry through its delete button', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: [
        ...DINGTALK.fields,
        {
          key: 'boundSessionActions',
          label: 'Bound Session Actions',
          kind: 'record',
          options: [{ value: 'fix:comment', label: 'fix:comment' }],
        },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor, instance: INSTANCE, onSave });

    await selectOption('Bound Session Actions', 'fix:comment');
    const remove = Array.from(document.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Remove fix:comment',
    );
    expect(remove).toBeDefined();
    await act(async () => {
      remove!.click();
    });
    expect(document.querySelectorAll('textarea')).toHaveLength(0);

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    const request = onSave.mock.calls[0]?.[1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['boundSessionActions']).toBeUndefined();
  });

  it('keeps stored record keys the descriptor does not enumerate', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: [
        ...DINGTALK.fields,
        {
          key: 'boundSessionActions',
          label: 'Bound Session Actions',
          kind: 'record',
          options: [{ value: 'fix:comment', label: 'fix:comment' }],
        },
      ],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: {
        ...INSTANCE.config,
        boundSessionActions: { 'custom:key': 'Do the custom thing' },
      },
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor, instance, onSave });

    const label = Array.from(document.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('custom:key'),
    );
    expect(label).toBeDefined();
    const textarea = document.getElementById(
      label!.htmlFor,
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Do the custom thing');

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
    expect(onSave).toHaveBeenCalledWith(
      'release-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          boundSessionActions: { 'custom:key': 'Do the custom thing' },
        }),
      }),
    );
  });

  it('uses generic copy and no picker for an options-less record field', async () => {
    // messageRoutes is a record field with no options: the empty state must
    // not call routes "templates", and there is nothing to add from.
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: [
        ...DINGTALK.fields,
        { key: 'messageRoutes', label: 'Message Routes', kind: 'record' },
      ],
    };
    await renderDialog({ descriptor });
    await expandAdvancedSettings();

    expect(document.body.textContent).toContain('No entries configured yet.');
    expect(document.body.textContent).not.toContain(
      'No templates configured yet.',
    );
    // No add picker: the field label targets no control.
    expect(fieldByLabel('Message Routes')).toBeNull();

    // Stored routes still render as editable rows without a picker.
    const instance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: {
        ...INSTANCE.config,
        messageRoutes: { '/qa': 'Answer questions' },
      },
    };
    await renderDialog({ descriptor, instance });
    await expandAdvancedSettings();
    const label = Array.from(document.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('/qa'),
    );
    expect(label).toBeDefined();
    const textarea = document.getElementById(
      label!.htmlFor,
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Answer questions');
    expect(fieldByLabel('Message Routes')).toBeNull();
  });

  it('gates adding templates on bound delivery and names the prerequisite', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'github',
      displayName: 'GitHub',
      manageable: true,
      fields: [
        {
          key: 'useLocalGh',
          label: 'Use Local GitHub CLI Authentication',
          kind: 'boolean',
        },
        {
          key: 'deliverToBoundSessions',
          label: 'Deliver To PR-Bound Sessions',
          kind: 'boolean',
          default: 'false',
        },
        {
          key: 'boundSessionActions',
          label: 'Bound Session Actions',
          kind: 'record',
          options: [{ value: 'fix:comment', label: 'fix:comment' }],
        },
      ],
    };
    await renderDialog({ descriptor });

    const picker = fieldByLabel('Bound Session Actions') as HTMLButtonElement;
    expect(picker.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      'Enable "Deliver To PR-Bound Sessions" above to add templates.',
    );
    // The github-typed field keeps the template-worded empty state and
    // add-picker placeholder through its field label-key overrides.
    expect(document.body.textContent).toContain('No templates configured yet.');
    expect(document.body.textContent).toContain('Add template…');

    // Resolve the delivery switch by its label instead of guessing ids.
    const deliveryLabel = Array.from(document.querySelectorAll('label')).find(
      (item) =>
        item.textContent?.includes('Deliver To PR-Bound Sessions') &&
        item.htmlFor,
    );
    const deliverySwitch = document.getElementById(deliveryLabel!.htmlFor)!;
    await act(async () => {
      deliverySwitch.click();
    });
    expect(
      (fieldByLabel('Bound Session Actions') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('toggles the editor dialog fullscreen and back', async () => {
    await renderDialog();
    const toggle = Array.from(document.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Fullscreen',
    );
    expect(toggle).toBeDefined();
    expect(toggle!.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      toggle!.click();
    });
    expect(toggle!.getAttribute('aria-pressed')).toBe('true');
    expect(toggle!.getAttribute('aria-label')).toBe('Exit fullscreen');
    await act(async () => {
      toggle!.click();
    });
    expect(toggle!.getAttribute('aria-pressed')).toBe('false');
  });

  it('resolves the boundSessionActions label and description in Chinese', async () => {
    // FIELD_LABEL_KEYS.github must register the field, or the zh-CN editor
    // falls back to the descriptor's English label and description.
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      type: 'github',
      displayName: 'GitHub',
      fields: [
        {
          key: 'deliverToBoundSessions',
          label: 'Deliver To PR-Bound Sessions',
          kind: 'boolean',
          default: 'false',
        },
        {
          key: 'boundSessionActions',
          label: 'Bound Session Actions',
          kind: 'record',
          options: [
            { value: 'default', label: 'default', group: 'any' },
            {
              value: 'watch:ci_failure',
              label: 'watch:ci_failure',
              group: 'any',
            },
          ],
        },
      ],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: { ...INSTANCE.config, deliverToBoundSessions: true },
    };
    await renderDialog({ descriptor, instance, language: 'zh-CN' });
    expect(document.body.textContent).toContain('绑定会话动作模板');
    expect(document.body.textContent).toContain(
      '投递给 PR 绑定会话的 operator 指令模板',
    );
    // The template-worded empty state comes from the zh-CN field override.
    expect(document.body.textContent).toContain('尚未配置模板。');

    // The picker group header and the per-key description must both come
    // from the zh-CN dictionary, not the English descriptor fallback.
    const trigger = fieldByLabel('绑定会话动作模板')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('任意角色');
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.includes('watch:ci_failure'));
    expect(option).toBeDefined();
    expect(option!.textContent).toContain('head 提交上的 CI 检查变红');
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('head 提交上的 CI 检查变红');
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
        privatePolicy: 'pairing',
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
    expect(inputByLabel('Allowed user IDs')).not.toBeNull();
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
        privatePolicy: 'allowlist',
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

  it('edits who can talk in groups and the session operators', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK_WITH_ACCESS,
      fields: [
        ...DINGTALK_WITH_ACCESS.fields,
        { key: 'operators', label: 'Session Operators', kind: 'string-list' },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor, onSave });
    // Operators is a permission grant: it renders in Access control, not in
    // the advanced panel, so no expansion is needed here.
    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'release-bot');
      setInputValue(inputByLabel('Client ID')!, 'ding-client-id');
      setInputValue(inputByLabel('Client Secret')!, 'ding-client-secret');
    });

    expect(fieldByLabel('Who can talk in groups')).toBeNull();
    await selectOption('Group policy', 'Pairing');
    expect(fieldByLabel('Who can talk in groups')?.textContent).toContain(
      'Any group member',
    );
    await selectOption('Group policy', 'Open');
    expect(fieldByLabel('Who can talk in groups')?.textContent).toContain(
      'Any group member',
    );
    expect(inputByLabel('Allowed group member IDs')).toBeNull();

    await selectOption('Who can talk in groups', 'Listed members only');
    await act(async () => {
      setInputValue(inputByLabel('Allowed group member IDs')!, 'alice, bob');
      setInputValue(inputByLabel('Session operators')!, 'admin');
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'release-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          groupPolicy: 'open',
          operators: ['admin'],
          groups: {
            '*': { senders: 'allowlist', allowedUsers: ['alice', 'bob'] },
          },
        }),
      }),
    );
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

    // The pre-existing hint call sites pass no hintId: the local-gh hint
    // must keep rendering without an id or a live region.
    expect(document.querySelectorAll('span[aria-live]').length).toBe(0);
    expect(document.querySelectorAll('span[id]').length).toBe(0);

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
      },
      secrets: { token: { operation: 'clear' } },
    });
  });

  it('renders the reason filter as checkboxes and saves the checked reasons', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: GITHUB_CONFIGURED, onSave });
    await expandAdvancedSettings();

    const group = document.querySelector(
      '[role="group"][aria-label="Reason Filter"]',
    );
    const boxes = Array.from(
      group?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [],
    );
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual([
      'mention — the bot is @mentioned',
      'review_requested — the bot, or a team it belongs to, was asked to review a pull request',
      'ci_activity — a workflow run the bot triggered completed',
      'comment — the bot commented on the thread',
    ]);

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'github-bot');
      setInputValue(inputByLabel('Personal Access Token')!, 'ghp_test');
    });
    for (const label of [
      'mention — the bot is @mentioned',
      'ci_activity — a workflow run the bot triggered completed',
    ]) {
      await act(async () => {
        Array.from(
          group?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ??
            [],
        )
          .find((box) => box.closest('label')?.textContent === label)
          ?.click();
      });
    }

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'github-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          reasonFilter: ['mention', 'ci_activity'],
        }),
      }),
    );
  });

  it('ticks the canonical reason box for a stored upper-case value', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        reasonFilter: ['COMMENT'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance });

    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="Reason Filter"] input[type="checkbox"]',
      ),
    );
    // The adapter lowercases both sides, so `COMMENT` is the canonical
    // `comment` reason: it must tick that box, not add a sixteenth entry that
    // keeps processing comments after the operator unticks `comment`.
    expect(boxes).toHaveLength(4);
    const byLabel = new Map(
      boxes.map((box) => [box.closest('label')?.textContent, box.checked]),
    );
    expect(byLabel.get('comment — the bot commented on the thread')).toBe(true);
    expect(byLabel.get('mention — the bot is @mentioned')).toBe(false);
  });

  it('keeps a hand-written reason visible instead of dropping it on save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        reasonFilter: ['mention', 'typo_reason'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance, onSave });

    const unknown = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="Reason Filter"] input[type="checkbox"]',
      ),
    ).find((box) => box.closest('label')?.textContent === 'typo_reason');
    expect(unknown).toBeDefined();
    expect(unknown!.checked).toBe(true);

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(document.body.textContent).toContain(
      "Remove values that aren't in the allowed list.",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('locks the token input while local gh authentication is selected', async () => {
    await renderDialog({ descriptor: GITHUB_CONFIGURED });

    expect(inputByLabel('Personal Access Token')).not.toBeNull();

    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    await act(async () => {
      toggle!.click();
    });

    expect(inputByLabel('Personal Access Token')).toBeNull();
    expect(document.body.textContent).toContain(
      'Local gh authentication is selected. The token cannot be edited here,',
    );
  });

  it('keeps the stored token when local gh authentication is switched back off', async () => {
    // The switch is a preference. Turning it on queues the token for removal
    // because a token outranks gh; turning it back off must undo that, or the
    // operator is locked out of saving until they retype a PAT.
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: { type: 'github', groupPolicy: 'open', useLocalGh: false },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance, onSave });

    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      toggle!.click();
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(document.body.textContent).not.toContain(
      'Enter a token or enable local GitHub CLI authentication.',
    );
    expect(onSave).toHaveBeenCalledWith(
      'github-bot',
      expect.objectContaining({
        config: expect.objectContaining({ useLocalGh: false }),
        secrets: { token: { operation: 'preserve' } },
      }),
    );
  });

  it('keeps a newly entered PAT when local gh is switched on and back off', async () => {
    // Restoring `preserve` unconditionally would drop the token the operator
    // just typed: a new channel would then submit no credential at all, with
    // the input gone so it cannot be re-entered.
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: GITHUB_CONFIGURED, onSave });

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'github-bot');
      setInputValue(inputByLabel('Personal Access Token')!, 'ghp_typed');
    });
    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      toggle!.click();
    });

    expect(inputByLabel('Personal Access Token')?.value).toBe('ghp_typed');

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'github-bot',
      expect.objectContaining({
        config: expect.objectContaining({ useLocalGh: false }),
        secrets: { token: { operation: 'replace', value: 'ghp_typed' } },
      }),
    );
  });

  it('keeps a replacement PAT when local gh is switched on and back off', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: { type: 'github', groupPolicy: 'open', useLocalGh: false },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance, onSave });

    const replace = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Replace',
    );
    await act(async () => {
      replace!.click();
    });
    await act(async () => {
      setInputValue(inputByLabel('Personal Access Token')!, 'ghp_replacement');
    });
    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      toggle!.click();
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'github-bot',
      expect.objectContaining({
        config: expect.objectContaining({ useLocalGh: false }),
        secrets: { token: { operation: 'replace', value: 'ghp_replacement' } },
      }),
    );
  });

  it('clears a stored token when local gh authentication is switched on', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: { type: 'github', groupPolicy: 'open', useLocalGh: false },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance, onSave });

    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    await act(async () => {
      toggle!.click();
    });

    // The stored credential cannot be re-opened for editing while gh is
    // selected, otherwise Replace would silently outrank the switch again.
    for (const label of ['Keep', 'Replace', 'Clear']) {
      const button = Array.from(document.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === label,
      );
      expect(button).toBeDefined();
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      'github-bot',
      expect.objectContaining({
        config: expect.objectContaining({ useLocalGh: true }),
        secrets: { token: { operation: 'clear' } },
      }),
    );
  });

  it('refuses to collapse repository aliases that carry different settings', async () => {
    // GitHub treats both spellings as one repository, but the runtime resolves
    // an exact key first. Collapsing them would keep the empty entry and widen
    // the sender policy on a save the operator meant as a no-op.
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        groups: {
          'QwenLM/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
          'qwenlm/qwen-code': {},
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance, onSave });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(document.body.textContent).toContain(
      'This channel lists one repository twice with different settings',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('files connection and notification tuning under advanced settings', async () => {
    await renderDialog({ descriptor: GITHUB_CONFIGURED });
    await expandAdvancedSettings();

    // The endpoint stays in Connection; only the notification tuning moves.
    expect(sectionHeadingOf(inputByLabel('Base URL'))).toBe('Connection');
    const panel = fieldByLabel('Reason Filter')?.closest(
      '[data-slot="collapsible"]',
    );
    expect(panel?.textContent).toContain('Advanced settings');
    expect(sectionHeadingOf(inputByLabel('Personal Access Token'))).toBe(
      'Credentials',
    );
    expect(inputByLabel('Base URL')?.placeholder).toBe(
      'https://ghe.example.com/api/v3',
    );
  });

  it('files connection and routing tuning under advanced settings for a non-GitHub channel', async () => {
    // A stored default route keeps its field visible even without routes, so
    // the fixture can assert the whole routing group inside the panel.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'gitlab-bot',
      config: { type: 'gitlab', defaultMessageRoute: '/qa' },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITLAB_ROUTING, instance });
    await expandAdvancedSettings();

    expect(sectionHeadingOfLabel('Personal Access Token')).toBe('Credentials');
    expect(sectionHeadingOfLabel('Instance URL')).toBe('Connection');
    const panelOf = (labelText: string) =>
      Array.from(document.querySelectorAll('label'))
        .find((item) => item.textContent?.includes(labelText))
        ?.closest('[data-slot="collapsible"]');
    const panel = panelOf('Message Routes');
    expect(panel?.textContent).toContain('Advanced settings');
    expect(panelOf('Default Message Route')).toBe(panel);
  });

  it('asks for repository full names when GitHub groups are allowlisted', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({ descriptor: GITHUB_CONFIGURED, onSave });

    await selectOption('Group Policy', 'Allowlist');
    const repos = inputByLabel('Allowed repositories');
    expect(repos?.placeholder).toBe('owner/repo');

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'github-bot');
      setInputValue(inputByLabel('Personal Access Token')!, 'ghp_test');
      setInputValue(repos!, 'qwen-code');
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });

    expect(document.body.textContent).toContain(
      'Enter each repository as owner/repo.',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('hides the direct-message policy for a repository-only channel', async () => {
    await renderDialog({ descriptor: GITHUB_CONFIGURED });

    expect(document.body.textContent).not.toContain('Direct message policy');
    expect(document.body.textContent).not.toContain('Allowed user IDs');
  });

  it('asks a repository-only channel to save group pairing before showing approvals', async () => {
    // Channels saved by the previous editor carry the injected
    // privatePolicy: 'pairing'. That legacy value must not open the
    // direct-message pairing panel when the operator switches the *group*
    // policy to pairing in the draft.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        privatePolicy: 'pairing',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance });

    await selectOption('Group Policy', 'Pairing');

    expect(document.body.textContent).toContain('Save pairing mode first');
    expect(document.body.textContent).not.toContain('Pairing approvals');
  });

  it('still shows group pairing approvals for a repository-only channel', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'pairing',
        allowedUsers: ['alice'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const listPairingRequests = vi.fn().mockResolvedValue({ requests: [] });
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance,
      listPairingRequests,
    });

    expect(document.body.textContent).toContain('Pairing approvals');
    expect(listPairingRequests).toHaveBeenCalledWith('github-bot');
    // The private user list is not the effective sender allowlist for a
    // repository, so it must not be presented as one.
    expect(document.body.textContent).not.toContain('Configured allowlist');
    expect(document.body.textContent).not.toContain('alice');
  });

  it('does not show the allowlist alert when no users are configured', async () => {
    const pairingNoAllowlist: DaemonChannelInstanceSnapshot = {
      ...INSTANCE,
      config: { ...INSTANCE.config, privatePolicy: 'pairing' },
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
        privatePolicy: 'open',
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
        privatePolicy: 'open',
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
        privatePolicy: 'open',
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

describe('GitHub per-repository settings', () => {
  const GITHUB_POLLING: DaemonChannelTypeDescriptor = {
    ...GITHUB_CONFIGURED,
    fields: [
      ...GITHUB_CONFIGURED.fields,
      {
        key: 'pollInterval',
        label: 'Poll Interval (ms)',
        kind: 'number',
        exclusiveMinimum: 0,
        maximum: 86_400_000,
        default: '60000',
      },
    ],
  };

  function githubInstance(
    groups: Record<string, unknown>,
  ): DaemonChannelInstanceSnapshot {
    return {
      name: 'github-bot',
      config: { type: 'github', groupPolicy: 'allowlist', groups },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
  }

  function rowLabels(text: string): HTMLElement[] {
    return Array.from(document.querySelectorAll('label')).filter((label) =>
      label.textContent?.includes(text),
    );
  }

  function rowControl(
    repositoryId: string,
    kind: 'mention' | 'senders' | 'speakers',
  ): HTMLElement | null {
    return document.querySelector(`[id$="-${kind}-${repositoryId}"]`);
  }

  async function chooseRowOption(
    repositoryId: string,
    kind: 'mention' | 'senders',
    optionLabel: string,
  ) {
    const trigger = rowControl(repositoryId, kind);
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

  async function save() {
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Save',
    );
    await act(async () => {
      button?.click();
    });
  }

  it('renders one row per allowlisted repository', async () => {
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': {},
        'qwenlm/qwen-code': {},
        'acme/widgets': {},
      }),
    });

    expect(rowLabels('Require a mention')).toHaveLength(2);
    expect(rowLabels('Who may speak')).toHaveLength(2);
    expect(document.body.textContent).toContain('qwenlm/qwen-code');
    expect(document.body.textContent).toContain('acme/widgets');
  });

  it('adds a row as soon as a repository is typed into the allowlist', async () => {
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({ 'qwenlm/qwen-code': {} }),
    });
    expect(rowLabels('Require a mention')).toHaveLength(1);

    const allowlist = inputByLabel('Allowed repositories');
    expect(allowlist).not.toBeNull();
    await act(async () => {
      setInputValue(allowlist!, 'qwenlm/qwen-code, acme/widgets');
    });

    expect(rowLabels('Require a mention')).toHaveLength(2);
    expect(rowControl('acme/widgets', 'mention')).not.toBeNull();
  });

  it('names the inherited value in the inherit option', async () => {
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { requireMention: false, senders: 'allowlist' },
        'qwenlm/qwen-code': {},
      }),
    });

    expect(rowControl('qwenlm/qwen-code', 'mention')?.textContent).toContain(
      'Inherit (answer without a mention)',
    );
    expect(rowControl('qwenlm/qwen-code', 'senders')?.textContent).toContain(
      'Inherit (allowlist only)',
    );
  });

  it('shows the speaker input only once the row allows a list', async () => {
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'open' },
        'qwenlm/qwen-code': {},
      }),
    });
    expect(rowControl('qwenlm/qwen-code', 'speakers')).toBeNull();

    await chooseRowOption('qwenlm/qwen-code', 'senders', 'Allowlist only');

    expect(rowControl('qwenlm/qwen-code', 'speakers')).not.toBeNull();
  });

  it('shows the speaker input for a row inheriting an allowlist', async () => {
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'qwenlm/qwen-code': {},
      }),
    });

    expect(rowControl('qwenlm/qwen-code', 'speakers')).not.toBeNull();
    expect(rowControl('qwenlm/qwen-code', 'senders')?.textContent).toContain(
      'Inherit (allowlist only)',
    );
  });

  it('saves an explicit per-repository override', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({ 'qwenlm/qwen-code': {} }),
      onSave,
    });

    await chooseRowOption(
      'qwenlm/qwen-code',
      'mention',
      'Answer without a mention',
    );
    await chooseRowOption('qwenlm/qwen-code', 'senders', 'Allowlist only');
    await act(async () => {
      setInputValue(
        rowControl('qwenlm/qwen-code', 'speakers') as HTMLInputElement,
        'alice, bob',
      );
    });
    await save();

    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['groups']).toEqual({
      'qwenlm/qwen-code': {
        requireMention: false,
        senders: 'allowlist',
        allowedUsers: ['alice', 'bob'],
      },
    });
  });

  it('labels each row so repeated control names stay distinguishable', async () => {
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        'qwenlm/qwen-code': {},
        'acme/widgets': {},
      }),
    });

    const rows = Array.from(
      document.querySelectorAll('[role="group"][aria-labelledby]'),
    ).filter((row) => row.querySelector('h4'));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelector('h4')?.textContent)).toEqual([
      'qwenlm/qwen-code',
      'acme/widgets',
    ]);
    for (const row of rows) {
      expect(row.getAttribute('aria-labelledby')).toBe(
        row.querySelector('h4')?.id,
      );
    }
  });

  it('renders the poll interval under advanced settings', async () => {
    await renderDialog({ descriptor: GITHUB_POLLING });
    await expandAdvancedSettings();

    const panel = Array.from(document.querySelectorAll('label'))
      .find((item) => item.textContent?.includes('Poll Interval (ms)'))
      ?.closest('[data-slot="collapsible"]');
    expect(panel?.textContent).toContain('Advanced settings');
    expect(inputByLabel('Poll Interval (ms)')?.type).toBe('number');
  });

  it('files the poll interval under advanced settings for any platform declaring it', async () => {
    // The advanced map is keyed by field name, so Email's existing interval
    // moves too. Pin the documented side effect instead of leaving it to prose.
    const email: DaemonChannelTypeDescriptor = {
      type: 'email',
      displayName: 'Email',
      manageable: true,
      fields: [
        {
          key: 'pollInterval',
          label: 'Poll Interval (ms)',
          kind: 'number',
          exclusiveMinimum: 0,
          default: '60000',
        },
      ],
    };
    await renderDialog({ descriptor: email });
    await expandAdvancedSettings();

    const panel = Array.from(document.querySelectorAll('label'))
      .find((item) => item.textContent?.includes('Poll Interval (ms)'))
      ?.closest('[data-slot="collapsible"]');
    expect(panel?.textContent).toContain('Advanced settings');
    expect(document.body.textContent).not.toContain('Per-repository settings');
  });

  it('keeps repository rows away from chat platforms', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'chat-bot',
      config: {
        type: 'dingtalk',
        clientId: 'id',
        clientSecret: 'secret',
        groupPolicy: 'allowlist',
        // Shaped like a repository on purpose: a `group-a` fixture would pass
        // even if the platform gate were removed, because the owner/repo
        // filter would hide the rows anyway.
        groups: { 'acme/widgets': {} },
      },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: DINGTALK_WITH_ACCESS, instance });

    expect(rowLabels('Require a mention')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Per-repository settings');
  });

  it('derives the speaker hint from what the save will own, not the draft policy', async () => {
    // Two stored shapes this PR deliberately preserves. A policy with no list
    // inherits the channel-wide members; a list with no policy admits nobody.
    // Reading the hint off the draft policy tells both the opposite.
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op', 'release-bot'] },
        'qwenlm/qwen-code': { senders: 'allowlist' },
        'acme/widgets': { allowedUsers: [] },
      }),
    });

    expect(descriptionOf(rowControl('qwenlm/qwen-code', 'speakers'))).toContain(
      'Leave empty to use the channel-wide list',
    );
    expect(descriptionOf(rowControl('acme/widgets', 'speakers'))).toContain(
      'Empty means nobody',
    );
  });

  it('shows each row its own stored speakers and edits only that row', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'qwenlm/qwen-code': {
          senders: 'allowlist',
          allowedUsers: ['alice', 'bob'],
        },
        'acme/widgets': {},
      }),
      onSave,
    });

    expect(
      (rowControl('qwenlm/qwen-code', 'speakers') as HTMLInputElement).value,
    ).toBe('alice, bob');
    expect(
      (rowControl('acme/widgets', 'speakers') as HTMLInputElement).value,
    ).toBe('');

    await act(async () => {
      setInputValue(
        rowControl('acme/widgets', 'speakers') as HTMLInputElement,
        'carol',
      );
    });
    await save();

    const request = onSave.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['groups']).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': {
        senders: 'allowlist',
        allowedUsers: ['alice', 'bob'],
      },
      'acme/widgets': { allowedUsers: ['carol'] },
    });
  });

  it('shows an explicitly open row as Anyone rather than as inheriting', async () => {
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'qwenlm/qwen-code': { senders: 'open' },
      }),
    });

    expect(rowControl('qwenlm/qwen-code', 'senders')?.textContent).toContain(
      'Anyone',
    );
    expect(rowControl('qwenlm/qwen-code', 'speakers')).toBeNull();
  });

  it('renders the localized interval label, not the descriptor fallback', async () => {
    // The fixture's descriptor label is byte-identical to the English string,
    // so only a zh-CN render proves the label mapping is load-bearing.
    await renderDialog({ descriptor: GITHUB_POLLING, language: 'zh-CN' });
    await expandAdvancedSettings('高级设置');

    expect(inputByLabel('轮询间隔（毫秒）')).not.toBeNull();
    const panel = Array.from(document.querySelectorAll('label'))
      .find((item) => item.textContent?.includes('轮询间隔（毫秒）'))
      ?.closest('[data-slot="collapsible"]');
    expect(panel?.textContent).toContain('高级设置');
  });

  it('names the repositories whose settings outlive the allowlist policy', async () => {
    // The runtime resolves per-repository senders without consulting
    // groupPolicy, so switching the policy away must not make those entries
    // invisible while they still decide who may drive the agent.
    const instance = githubInstance({
      '*': {},
      'acme/widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
    instance.config['groupPolicy'] = 'open';
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance });

    expect(rowLabels('Require a mention')).toHaveLength(0);
    expect(document.body.textContent).toContain(
      'Repository settings still apply',
    );
    expect(document.body.textContent).toContain('acme/widgets');
  });

  it('says nothing about retained settings when there are none', async () => {
    const instance = githubInstance({ '*': { senders: 'open' } });
    instance.config['groupPolicy'] = 'open';
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance });

    expect(document.body.textContent).not.toContain(
      'Repository settings still apply',
    );
  });

  it('saves an unrelated edit on a channel whose stored interval the runtime tolerates', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: { type: 'github', groupPolicy: 'open', pollInterval: 0 },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_POLLING, instance, onSave });

    expect(inputByLabel('Poll Interval (ms)')?.value).toBe('0');
    await save();

    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['pollInterval']).toBe(0);
  });

  it('tells a stored list under an inherited policy that clearing it returns the channel-wide list', async () => {
    // The hint promises what an EMPTY box will do. Asking the projection about
    // the untouched draft would say "nobody" here, while clearing the box
    // actually deletes the list and widens the repository back to the wildcard.
    // The repository's own list is the admitted set until then, so the hint has
    // to say the channel-wide list will be *used*, not that it is already kept.
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op', 'release-bot'] },
        'qwenlm/qwen-code': { allowedUsers: ['alice'] },
      }),
      onSave,
    });

    const speakers = rowControl(
      'qwenlm/qwen-code',
      'speakers',
    ) as HTMLInputElement;
    expect(speakers.value).toBe('alice');
    expect(descriptionOf(speakers)).toContain(
      'Leave empty to use the channel-wide list',
    );

    await act(async () => setInputValue(speakers, ''));
    await save();

    // What the hint promised: the repository no longer owns a list, so the
    // runtime's `??` hands it the two channel-wide members instead of alice.
    const request = onSave.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['groups']).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op', 'release-bot'] },
      'qwenlm/qwen-code': {},
    });
  });

  it('says the retained settings are kept but inert while the policy is Disabled', async () => {
    // The group gate drops every envelope before the mention or sender lookup,
    // so "still apply" would be false under Disabled.
    const instance = githubInstance({
      '*': {},
      'acme/widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
    instance.config['groupPolicy'] = 'disabled';
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance });

    expect(document.body.textContent).toContain(
      'Repository settings are kept but not applied',
    );
    expect(document.body.textContent).not.toContain(
      'Repository settings still apply',
    );
    expect(document.body.textContent).toContain('acme/widgets');
  });

  it('refuses an edited row when the policy leaves a conflicting allowlist', async () => {
    // The rows disappear once the policy leaves Allowlist and the save path
    // keeps both spellings as stored, so an edit made before switching would be
    // discarded while the dialog closes on success. The error has to land on a
    // control still on screen — the policy select, not the hidden allowlist.
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        groups: {
          '*': { senders: 'allowlist', allowedUsers: ['op'] },
          'Acme/Widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
          'acme/widgets': { senders: 'open' },
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance, onSave });

    await chooseRowOption('acme/widgets', 'senders', 'Allowlist only');
    await selectOption('Group Policy', 'Open');
    await save();

    expect(document.body.textContent).toContain(
      'This channel lists one repository twice with different settings',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('still saves an untouched switch away from a conflicting allowlist', async () => {
    // Refusing every save would strand an operator who only changed the policy:
    // keeping both spellings verbatim is what the runtime already resolved.
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        groups: {
          '*': { senders: 'allowlist', allowedUsers: ['op'] },
          'Acme/Widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
          'acme/widgets': { senders: 'open' },
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITHUB_CONFIGURED, instance, onSave });

    await selectOption('Group Policy', 'Open');
    await save();

    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['groups']).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'Acme/Widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
      'acme/widgets': { senders: 'open' },
    });
  });

  it('names a repository the save writes but storage has never seen', async () => {
    // Typing a repository, narrowing its row and switching the policy away
    // writes an entry that keeps deciding who may drive that repository. The
    // alert used to enumerate stored groups, so it named nothing and the
    // dialog reported success in silence.
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
      }),
      onSave,
    });

    await act(async () => {
      setInputValue(inputByLabel('Allowed repositories')!, 'acme/widgets');
    });
    await chooseRowOption('acme/widgets', 'senders', 'Allowlist only');
    await act(async () => {
      setInputValue(
        rowControl('acme/widgets', 'speakers') as HTMLInputElement,
        'alice',
      );
    });
    await selectOption('Group Policy', 'Open');

    expect(document.body.textContent).toContain(
      'Repository settings still apply',
    );
    expect(document.body.textContent).toContain('acme/widgets');
  });

  it('does not announce a speaker list the resolved open policy makes inert', async () => {
    // senderGateFor builds an allowlist only when the resolved policy is
    // allowlist, so this array restricts nobody and must not be announced as a
    // setting that still applies.
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'open' },
        'acme/widgets': { allowedUsers: ['alice'] },
      }),
    });

    await selectOption('Group Policy', 'Open');

    expect(document.body.textContent).not.toContain(
      'Repository settings still apply',
    );
  });

  it('refuses a save while a stored group entry is not an object, and names it', async () => {
    // The store rejects such an entry on every save, unchanged or not, and no
    // row can represent it. A generic daemon error would leave the operator
    // with nothing to act on, so the refusal names the entry and where to fix
    // it — and the entry is still not deleted, which would widen the alias.
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'Acme/Widgets': 'hand-written-garbage',
      }),
      onSave,
    });

    await selectOption('Group Policy', 'Open');
    await save();

    expect(document.body.textContent).toContain(
      'stores a group entry that is not an object',
    );
    expect(document.body.textContent).toContain('Acme/Widgets');
    expect(document.body.textContent).toContain('settings.json');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('maps the Inherit option back to an absent key in both row selects', async () => {
    // The widget's `inherit` sentinel only becomes the draft's '' here, and a
    // cast hides a regression from the type checker: passing the raw value
    // through would write requireMention = ('inherit' === 'true') = false.
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_CONFIGURED,
      instance: githubInstance({
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'qwenlm/qwen-code': {
          requireMention: false,
          senders: 'allowlist',
          allowedUsers: ['alice'],
        },
      }),
      onSave,
    });

    await chooseRowOption(
      'qwenlm/qwen-code',
      'mention',
      'Inherit (require a mention)',
    );
    await chooseRowOption(
      'qwenlm/qwen-code',
      'senders',
      'Inherit (allowlist only)',
    );
    await save();

    const request = onSave.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    // A typed list survives a return to Inherit; only the two policy keys go.
    expect(request.config['groups']).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { allowedUsers: ['alice'] },
    });
  });

  it('names only the bounds the descriptor declares in the range message', async () => {
    const maxOnly: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'concurrency',
          label: 'Concurrency',
          kind: 'number',
          maximum: 4,
        },
      ],
    };
    await renderDialog({ descriptor: maxOnly });
    await act(async () => {
      setInputValue(inputByLabel('Concurrency')!, '9');
    });
    await save();

    expect(document.body.textContent).toContain('Enter a number at most 4.');
    expect(document.body.textContent).not.toContain('greater than');
  });

  it('names both bounds when the descriptor declares both', async () => {
    await renderDialog({ descriptor: GITHUB_POLLING });
    await expandAdvancedSettings();
    await act(async () => {
      setInputValue(inputByLabel('Poll Interval (ms)')!, '2592000000');
    });
    await save();

    expect(document.body.textContent).toContain(
      'Enter a number greater than 0 and at most 86400000.',
    );
  });

  it('words an inclusive floor as "at least", not "greater than"', async () => {
    // Naming the exclusive bound here would tell the operator "greater than
    // -1" — a floor the validator does not enforce, and one that reads as if
    // -0.5 were legal.
    const inclusive: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'reserve',
          label: 'Reserve',
          kind: 'number',
          minimum: 0,
          maximum: 5000,
        },
      ],
    };
    await renderDialog({ descriptor: inclusive });
    await act(async () => {
      setInputValue(inputByLabel('Reserve')!, '-0.5');
    });
    await save();

    expect(document.body.textContent).toContain(
      'Enter a number at least 0 and at most 5000.',
    );
    expect(document.body.textContent).not.toContain('greater than');
  });

  it('names the exclusive floor on a tie, because equality is rejected', async () => {
    // Both bounds at 5: the validator rejects 5, so "at least 5" would name a
    // floor it does not enforce — the very defect this change removes.
    const tie: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'reserve',
          label: 'Reserve',
          kind: 'number',
          exclusiveMinimum: 5,
          minimum: 5,
          maximum: 10,
        },
      ],
    };
    await renderDialog({ descriptor: tie });
    await act(async () => {
      setInputValue(inputByLabel('Reserve')!, '5');
    });
    await save();

    expect(document.body.textContent).toContain(
      'Enter a number greater than 5 and at most 10.',
    );
    expect(document.body.textContent).not.toContain('at least');
  });

  it('names the exclusive floor when it is stricter than the inclusive one', async () => {
    // Dropping the comparison entirely would always name the inclusive bound,
    // and here that is the weaker one: the validator rejects 5, so "at least
    // 2" would advertise a value the save refuses.
    const weakerInclusive: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'reserve',
          label: 'Reserve',
          kind: 'number',
          exclusiveMinimum: 5,
          minimum: 2,
          maximum: 10,
        },
      ],
    };
    await renderDialog({ descriptor: weakerInclusive });
    await act(async () => {
      setInputValue(inputByLabel('Reserve')!, '3');
    });
    await save();

    expect(document.body.textContent).toContain(
      'Enter a number greater than 5 and at most 10.',
    );
    expect(document.body.textContent).not.toContain('at least');
  });

  it('names the inclusive floor when it is strictly above the exclusive one', async () => {
    const both: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'reserve',
          label: 'Reserve',
          kind: 'number',
          exclusiveMinimum: 0,
          minimum: 2,
          maximum: 10,
        },
      ],
    };
    await renderDialog({ descriptor: both });
    await act(async () => {
      setInputValue(inputByLabel('Reserve')!, '1');
    });
    await save();

    expect(document.body.textContent).toContain(
      'Enter a number at least 2 and at most 10.',
    );
    expect(document.body.textContent).not.toContain('greater than');
  });
});

describe('Channel editor progressive disclosure', () => {
  function advancedTrigger(): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Advanced settings'),
    );
  }

  async function clickAdvancedTrigger() {
    const trigger = advancedTrigger();
    expect(trigger).toBeDefined();
    await act(async () => {
      trigger!.click();
    });
  }

  async function saveDialog() {
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
  }

  it('hides the default message route until a route exists', async () => {
    await renderDialog({ descriptor: GITLAB_ROUTING });
    await expandAdvancedSettings();

    // Record fields render a label without a control id, so assert on the
    // label text rather than fieldByLabel.
    const labels = Array.from(document.querySelectorAll('label')).map(
      (label) => label.textContent ?? '',
    );
    expect(labels.some((text) => text.includes('Message Routes'))).toBe(true);
    expect(labels.some((text) => text.includes('Default Message Route'))).toBe(
      false,
    );
  });

  it('shows the default message route when routes are configured', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'gitlab-bot',
      config: {
        type: 'gitlab',
        messageRoutes: { '/qa': 'Answer questions' },
      },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITLAB_ROUTING, instance });
    await expandAdvancedSettings();

    expect(fieldByLabel('Default Message Route')).not.toBeNull();
  });

  it('collapses advanced settings on a fresh draft', async () => {
    await renderDialog({ descriptor: GITHUB_CONFIGURED });

    expect(advancedTrigger()?.getAttribute('data-state')).toBe('closed');
    // The primary endpoint stays visible; only tuning collapses.
    expect(sectionHeadingOf(inputByLabel('Base URL'))).toBe('Connection');
    expect(fieldByLabel('Reason Filter')).toBeNull();
    // No count badge while nothing is configured (the word also occurs in
    // unrelated field copy, so scope the check to the trigger).
    expect(advancedTrigger()?.textContent).not.toContain('configured');

    await clickAdvancedTrigger();
    expect(advancedTrigger()?.getAttribute('data-state')).toBe('open');
    expect(fieldByLabel('Reason Filter')).not.toBeNull();
  });

  it('renders the advanced panel title as a heading outside the trigger', async () => {
    await renderDialog({ descriptor: GITHUB_CONFIGURED });

    // ARIA makes a button's descendants presentational, so the section title
    // must be a real heading wrapping the trigger, not a span inside it.
    const heading = Array.from(document.querySelectorAll('h3')).find((h) =>
      h.textContent?.includes('Advanced settings'),
    );
    expect(heading).toBeDefined();
    const trigger = advancedTrigger();
    expect(trigger?.tagName).toBe('BUTTON');
    expect(heading!.contains(trigger!)).toBe(true);
  });

  it('opens advanced settings for configured values and badges the count when collapsed', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...GITHUB_CONFIGURED,
      fields: [
        ...GITHUB_CONFIGURED.fields,
        {
          key: 'instructions',
          label: 'Instructions',
          kind: 'string',
          multiline: true,
        },
      ],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        reasonFilter: ['mention'],
        instructions: 'Review carefully',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor, instance });

    expect(advancedTrigger()?.getAttribute('data-state')).toBe('open');
    expect(fieldByLabel('Instructions')).toHaveProperty(
      'value',
      'Review carefully',
    );

    await clickAdvancedTrigger();
    expect(advancedTrigger()?.getAttribute('data-state')).toBe('closed');
    expect(advancedTrigger()?.textContent).toContain('2 configured');
  });

  it('opens advanced settings for a stored boolean value', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...GITHUB_CONFIGURED,
      fields: [
        ...GITHUB_CONFIGURED.fields,
        { key: 'multiSession', label: 'Named Sessions', kind: 'boolean' },
      ],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: { type: 'github', groupPolicy: 'open', multiSession: true },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor, instance });

    // Pins the boolean arm of the configured predicate: without it the
    // stored value would open collapsed out of sight.
    expect(advancedTrigger()?.getAttribute('data-state')).toBe('open');
  });

  it('opens advanced settings for stored message routes', async () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'gitlab-bot',
      config: {
        type: 'gitlab',
        messageRoutes: { '/qa': 'Answer questions' },
      },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor: GITLAB_ROUTING, instance });

    // Pins the record arm of the configured predicate, without the tolerant
    // expand helper so the auto-open itself is what passes the test.
    expect(advancedTrigger()?.getAttribute('data-state')).toBe('open');
  });

  it('forces advanced settings open and scrolls the erroring field into view', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...GITHUB_CONFIGURED,
      fields: [
        ...GITHUB_CONFIGURED.fields,
        {
          key: 'pollInterval',
          label: 'Poll Interval (ms)',
          kind: 'number',
          exclusiveMinimum: 0,
          maximum: 86_400_000,
        },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    // jsdom has no scrollIntoView; stub it so the scroll is observable.
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await renderDialog({ descriptor, onSave });
      await expandAdvancedSettings();
      await act(async () => {
        setInputValue(inputByLabel('Poll Interval (ms)')!, '2592000000');
      });
      await clickAdvancedTrigger();
      expect(advancedTrigger()?.getAttribute('data-state')).toBe('closed');

      await saveDialog();

      expect(advancedTrigger()?.getAttribute('data-state')).toBe('open');
      expect(document.body.textContent).toContain(
        'Enter a number greater than 0 and at most 86400000.',
      );
      expect(onSave).not.toHaveBeenCalled();
      // Opening the panel is not enough: the error must be brought into
      // view, on the erroring control itself.
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
      expect(scrollIntoView.mock.instances[0]).toBe(
        inputByLabel('Poll Interval (ms)'),
      );
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('saves collapsed advanced values unchanged', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...GITHUB_CONFIGURED,
      fields: [
        ...GITHUB_CONFIGURED.fields,
        {
          key: 'instructions',
          label: 'Instructions',
          kind: 'string',
          multiline: true,
        },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        reasonFilter: ['mention', 'comment'],
        instructions: 'Review carefully',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({ descriptor, instance, onSave });
    await clickAdvancedTrigger();
    expect(advancedTrigger()?.getAttribute('data-state')).toBe('closed');

    await saveDialog();

    expect(onSave).toHaveBeenCalledWith(
      'github-bot',
      expect.objectContaining({
        config: expect.objectContaining({
          reasonFilter: ['mention', 'comment'],
          instructions: 'Review carefully',
        }),
      }),
    );
  });

  it('keeps primary endpoints in Connection while tuning moves to advanced', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'wecom',
      displayName: 'WeCom',
      manageable: true,
      fields: [
        { key: 'botId', label: 'Bot ID', kind: 'string', required: true },
        { key: 'wsUrl', label: 'WebSocket URL', kind: 'string' },
        { key: 'baseUrl', label: 'Base URL', kind: 'string' },
        {
          key: 'pollInterval',
          label: 'Poll Interval (ms)',
          kind: 'number',
          exclusiveMinimum: 0,
        },
      ],
    };
    await renderDialog({ descriptor });
    await expandAdvancedSettings();

    // Both endpoints decide where a token is sent, so a fresh draft must
    // show them; only genuine tuning collapses.
    expect(sectionHeadingOf(fieldByLabel('WebSocket URL'))).toBe('Connection');
    expect(sectionHeadingOf(fieldByLabel('Base URL'))).toBe('Connection');
    const panel = fieldByLabel('Poll Interval (ms)')?.closest(
      '[data-slot="collapsible"]',
    );
    expect(panel?.textContent).toContain('Advanced settings');
  });

  it('localizes the advanced panel and its count badge for zh-CN', async () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...GITHUB_CONFIGURED,
      fields: [
        ...GITHUB_CONFIGURED.fields,
        {
          key: 'instructions',
          label: 'Instructions',
          kind: 'string',
          multiline: true,
        },
      ],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'github-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        reasonFilter: ['mention'],
        instructions: 'Review carefully',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    await renderDialog({
      descriptor,
      instance,
      language: 'zh-CN',
    });

    const trigger = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('高级设置'),
    );
    expect(trigger).toBeDefined();
    expect(trigger?.getAttribute('data-state')).toBe('open');
    await act(async () => {
      trigger!.click();
    });
    expect(trigger?.textContent).toContain('已配置 2 项');
  });
});

describe('GitHub repository event filter', () => {
  // Same field keys as the real descriptor; labels intentionally differ from
  // the i18n values so a missing FIELD_LABEL_KEYS entry surfaces the
  // untranslated descriptor fallback instead of passing the assertions.
  const GITHUB_REPO_FILTER: DaemonChannelTypeDescriptor = {
    ...GITHUB_LOCAL_GH,
    fields: [
      ...GITHUB_LOCAL_GH.fields,
      {
        key: 'repoFilterMode',
        label: 'Repo filter mode (descriptor)',
        kind: 'enum',
        default: 'off',
        options: [
          { value: 'off', label: 'off' },
          { value: 'allowlist', label: 'allowlist' },
          { value: 'blocklist', label: 'blocklist' },
        ],
      },
      {
        key: 'repoFilter',
        label: 'Repo filter list (descriptor)',
        kind: 'string-list',
      },
    ],
  };

  const FILTER_INSTANCE: DaemonChannelInstanceSnapshot = {
    name: 'github-bot',
    config: { type: 'github', useLocalGh: true },
    secrets: {},
    startsWithServe: false,
    runtime: { state: 'stopped' },
  };

  async function saveDialog() {
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
  }

  it('defaults to Off and hides the repository list', async () => {
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: FILTER_INSTANCE,
    });

    expect(fieldByLabel('Repository Filter')).not.toBeNull();
    expect(inputByLabel('Filtered Repositories')).toBeNull();
  });

  it('renders the Chinese labels', async () => {
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: FILTER_INSTANCE,
      language: 'zh-CN',
    });

    expect(fieldByLabel('按仓库过滤')).not.toBeNull();
    await selectOption('按仓库过滤', '黑名单 — 除列出的仓库以外');
    expect(inputByLabel('过滤的仓库')).not.toBeNull();
  });

  it('reveals the list for an active mode and saves normalized repositories', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: FILTER_INSTANCE,
      onSave,
    });

    await selectOption(
      'Repository Filter',
      'Blocklist — all except listed repositories',
    );
    const input = inputByLabel('Filtered Repositories');
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, 'https://github.com/Octo/Repo/pull/123, octo/repo');
    });
    await saveDialog();

    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0]![1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['repoFilterMode']).toBe('blocklist');
    expect(request.config['repoFilter']).toEqual(['octo/repo']);
  });

  it('blocks an active mode with an empty list and retires the error on Off', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: FILTER_INSTANCE,
      onSave,
    });

    await selectOption(
      'Repository Filter',
      'Allowlist — only listed repositories',
    );
    await saveDialog();

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'List at least one repository, or set Repository Filter to Off.',
    );

    await selectOption('Repository Filter', 'Off — all repositories');
    expect(document.body.textContent).not.toContain(
      'List at least one repository, or set Repository Filter to Off.',
    );
    expect(inputByLabel('Filtered Repositories')).toBeNull();

    // The discriminating half: while Off the field is unmounted, so the
    // assertion above cannot see a stale error. Switching back remounts it —
    // the message must stay retired, which only happens if the mode switch
    // re-derived the shown errors instead of leaving them in the map.
    await selectOption(
      'Repository Filter',
      'Allowlist — only listed repositories',
    );
    expect(inputByLabel('Filtered Repositories')).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      'List at least one repository, or set Repository Filter to Off.',
    );
    await selectOption('Repository Filter', 'Off — all repositories');

    await saveDialog();
    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0]![1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['repoFilterMode']).toBe('off');
  });

  it('retires the shown error when a valid entry is typed, without saving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: FILTER_INSTANCE,
      onSave,
    });

    await selectOption(
      'Repository Filter',
      'Allowlist — only listed repositories',
    );
    await saveDialog();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'List at least one repository, or set Repository Filter to Off.',
    );

    await act(async () => {
      setInputValue(inputByLabel('Filtered Repositories')!, 'octo/repo');
    });
    expect(document.body.textContent).not.toContain(
      'List at least one repository, or set Repository Filter to Off.',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('retires the format error when the entry is corrected, without saving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: FILTER_INSTANCE,
      onSave,
    });

    await selectOption(
      'Repository Filter',
      'Blocklist — all except listed repositories',
    );
    await act(async () => {
      setInputValue(inputByLabel('Filtered Repositories')!, 'not-a-repo');
    });
    await saveDialog();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Enter each repository as owner/repo.',
    );

    await act(async () => {
      setInputValue(inputByLabel('Filtered Repositories')!, 'octo/repo');
    });
    expect(document.body.textContent).not.toContain(
      'Enter each repository as owner/repo.',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('opens on a stored active mode with its list and re-saves both keys', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: {
        ...FILTER_INSTANCE,
        config: {
          ...FILTER_INSTANCE.config,
          repoFilterMode: 'blocklist',
          repoFilter: ['octo/repo'],
        },
      },
      onSave,
    });

    const input = inputByLabel('Filtered Repositories');
    expect(input).not.toBeNull();
    expect(input).toHaveProperty('value', 'octo/repo');

    await saveDialog();
    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0]![1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['repoFilterMode']).toBe('blocklist');
    expect(request.config['repoFilter']).toEqual(['octo/repo']);
  });

  it('hides the list while Off and restores it on re-enable', async () => {
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: {
        ...FILTER_INSTANCE,
        config: {
          ...FILTER_INSTANCE.config,
          repoFilterMode: 'blocklist',
          repoFilter: ['octo/repo'],
        },
      },
    });

    expect(inputByLabel('Filtered Repositories')).toHaveProperty(
      'value',
      'octo/repo',
    );

    await selectOption('Repository Filter', 'Off — all repositories');
    expect(inputByLabel('Filtered Repositories')).toBeNull();

    await selectOption(
      'Repository Filter',
      'Blocklist — all except listed repositories',
    );
    expect(inputByLabel('Filtered Repositories')).toHaveProperty(
      'value',
      'octo/repo',
    );
  });

  it('rejects entries that are not owner/repo after normalization', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: FILTER_INSTANCE,
      onSave,
    });

    await selectOption(
      'Repository Filter',
      'Blocklist — all except listed repositories',
    );
    await act(async () => {
      setInputValue(inputByLabel('Filtered Repositories')!, 'not-a-repo');
    });
    await saveDialog();

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Enter each repository as owner/repo.',
    );
  });

  it('keeps a parked list exactly as stored while the mode is off', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: GITHUB_REPO_FILTER,
      instance: {
        ...FILTER_INSTANCE,
        config: {
          ...FILTER_INSTANCE.config,
          repoFilterMode: 'off',
          repoFilter: ['Owner/Parked'],
        },
      },
      onSave,
    });

    await saveDialog();

    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0]![1] as {
      config: Record<string, unknown>;
    };
    expect(request.config['repoFilterMode']).toBe('off');
    expect(request.config['repoFilter']).toEqual(['Owner/Parked']);
  });
});

describe('ChannelEditorDialog WeChat login', () => {
  // Mirrors the weixin plugin's management fields plus the shared controls the
  // registry appends. Hand-built because @qwen-code/channel-weixin is not a
  // web-shell devDependency; channel-editor-parity.test.ts owns the drift check
  // for the platform it can import.
  const WEIXIN: DaemonChannelTypeDescriptor = {
    type: 'weixin',
    displayName: 'WeChat',
    manageable: true,
    fields: [
      {
        key: 'groupPolicy',
        label: 'Group Policy',
        kind: 'enum',
        required: true,
        default: 'disabled',
        options: [{ value: 'disabled', label: 'Disabled' }],
      },
      {
        key: 'privatePolicy',
        label: 'Private Policy',
        kind: 'enum',
        required: true,
        default: 'pairing',
        options: [
          { value: 'disabled', label: 'Disabled' },
          { value: 'pairing', label: 'Pairing' },
          { value: 'allowlist', label: 'Allowlist' },
          { value: 'open', label: 'Open' },
        ],
      },
      { key: 'allowedUsers', label: 'Allowed Users', kind: 'string-list' },
    ],
  };

  function loginApi() {
    return {
      status: vi.fn().mockResolvedValue({ enabled: true, configured: false }),
      start: vi.fn(),
      poll: vi.fn(),
      cancel: vi.fn(),
      revoke: vi.fn(),
    };
  }

  async function saveDialog() {
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => {
      save?.click();
    });
  }

  it('renders the login panel for a WeChat channel', async () => {
    const api = loginApi();
    await renderDialog({ descriptor: WEIXIN, weixinLogin: api });

    expect(api.status).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="weixin-login-panel"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('Not logged in');
  });

  it('does not render the panel for other platforms', async () => {
    const api = loginApi();
    await renderDialog({ descriptor: DINGTALK, weixinLogin: api });

    expect(api.status).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="weixin-login-panel"]'),
    ).toBeNull();
  });

  it('renders exactly one credentials heading for WeChat', async () => {
    // The panel brings its own "Credentials" section. The field loop must not
    // add a second one: groupPolicy/privatePolicy/allowedUsers are shared
    // access fields and baseUrl is a connection field, so the loop's
    // credentials section has no fields and does not render.
    await renderDialog({ descriptor: WEIXIN, weixinLogin: loginApi() });

    const headings = Array.from(document.querySelectorAll('h3')).filter(
      (heading) => heading.textContent?.trim() === 'Credentials',
    );
    expect(headings).toHaveLength(1);
  });

  it('omits the panel when the host supplies no login API', async () => {
    await renderDialog({ descriptor: WEIXIN });

    expect(
      document.querySelector('[data-testid="weixin-login-panel"]'),
    ).toBeNull();
  });

  it('renders no credential input, because the token comes from QR login', async () => {
    await renderDialog({ descriptor: WEIXIN, weixinLogin: loginApi() });

    expect(document.querySelector('input[type="password"]')).toBeNull();
    const labels = Array.from(document.querySelectorAll('label')).map(
      (label) => label.textContent ?? '',
    );
    expect(labels.some((text) => /token|secret/i.test(text))).toBe(false);
  });

  it('saves a WeChat channel while logged out', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: WEIXIN,
      weixinLogin: loginApi(),
      onSave,
    });

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'my-weixin');
    });
    await saveDialog();

    expect(onSave).toHaveBeenCalledTimes(1);
    const [name, request] = onSave.mock.calls[0] as [
      string,
      { config: Record<string, unknown> },
    ];
    expect(name).toBe('my-weixin');
    expect(request.config['type']).toBe('weixin');
    // Login state must not gate configuration: the credential is independent.
    expect(request.config['groupPolicy']).toBe('disabled');
  });

  it('localizes the WeChat field labels in zh-CN', async () => {
    await renderDialog({
      descriptor: WEIXIN,
      weixinLogin: loginApi(),
      language: 'zh-CN',
    });

    expect(document.body.textContent).toContain('未登录');
    expect(document.body.textContent).toContain('扫码登录');
    const labels = Array.from(document.querySelectorAll('label')).map(
      (label) => label.textContent ?? '',
    );
    expect(labels.some((text) => text.includes('群聊策略'))).toBe(true);
    // Descriptor labels are English, so a missing i18n key would surface them.
    expect(labels.some((text) => text.includes('Group Policy'))).toBe(false);
  });

  it.each(['en', 'zh-CN'] as const)(
    'tells the operator the allowlist is optional and wants a platform id in %s',
    async (language) => {
      // The shared copy says "stable user IDs", which reads as a WeChat handle
      // and yields a silently inert entry. The platform override must say the
      // field can stay empty, name the pairing block, and show the id shape.
      await renderDialog({
        descriptor: WEIXIN,
        weixinLogin: loginApi(),
        language,
      });

      const text = document.body.textContent ?? '';
      if (language === 'zh-CN') {
        expect(text).toContain('预先放行的用户（可留空）');
        expect(text).toContain('建议留空');
        expect(text).toContain('待处理的配对请求');
        expect(text).toContain('填微信号或昵称不会生效');
      } else {
        expect(text).toContain('Pre-approved users (optional)');
        expect(text).toContain('Leave empty');
        expect(text).toContain('Pending requests');
        expect(text).toContain('A WeChat name or handle does not match');
      }
      // Both locales show the id shape, and neither falls back to the shared
      // wording that caused the confusion.
      expect(text).toContain('oAbCd…@im.wechat');
      expect(text).not.toContain('Comma-separated stable user IDs');
      expect(text).not.toContain('用英文逗号分隔稳定用户 ID');

      const input = inputByLabel(
        language === 'zh-CN' ? '预先放行的用户' : 'Pre-approved users',
      );
      expect(input?.getAttribute('placeholder')).toBe('oAbCd…@im.wechat');
    },
  );
});

/**
 * Email's access shape as the daemon ships it: the plugin declares
 * `privatePolicy` without `pairing`, and the registry injects `groupPolicy`
 * because the plugin does not declare it. The adapter builds every envelope
 * with `isGroup: false`, so the injected group controls must not reach the
 * operator.
 *
 * The credential labels are deliberately the raw config keys and the
 * descriptions are deliberately not the final copy. `fieldLabel` and
 * `fieldDescription` fall back to the descriptor, so a fixture carrying the
 * finished English text would pass with the whole i18n layer deleted. The real
 * plugin's own labels are pinned at the producer, by
 * `packages/cli/src/commands/channel/email-baseline.test.ts`.
 */
const EMAIL: DaemonChannelTypeDescriptor = {
  type: 'email',
  displayName: 'Email',
  manageable: true,
  fields: [
    { key: 'address', label: 'address', kind: 'string', required: true },
    { key: 'imapHost', label: 'imapHost', kind: 'string', required: true },
    {
      key: 'imapPassword',
      label: 'imapPassword',
      kind: 'secret',
      required: true,
    },
    {
      key: 'smtpPassword',
      label: 'smtpPassword',
      kind: 'secret',
      required: true,
    },
    {
      key: 'imapSecure',
      label: 'IMAP Implicit TLS',
      kind: 'boolean',
      default: 'true',
      description: 'Descriptor description',
    },
    {
      key: 'proactiveRecipients',
      label: 'Proactive Recipients',
      kind: 'string-list',
      description: 'Descriptor description',
    },
    // The rest of the plugin's field table, so the locale sweep below renders
    // every key FIELD_LABEL_KEYS.email maps rather than only the six the
    // targeted assertions name.
    { key: 'imapUser', label: 'imapUser', kind: 'string', required: true },
    { key: 'smtpHost', label: 'smtpHost', kind: 'string', required: true },
    { key: 'smtpUser', label: 'smtpUser', kind: 'string', required: true },
    { key: 'folder', label: 'IMAP Folder', kind: 'string', default: 'INBOX' },
    {
      key: 'imapPort',
      label: 'IMAP Port',
      kind: 'number',
      exclusiveMinimum: 0,
    },
    {
      key: 'smtpPort',
      label: 'SMTP Port',
      kind: 'number',
      exclusiveMinimum: 0,
    },
    {
      key: 'smtpSecure',
      label: 'SMTP Implicit TLS',
      kind: 'boolean',
      default: 'true',
      description: 'Descriptor description',
    },
    {
      key: 'pollInterval',
      label: 'Poll Interval (ms)',
      kind: 'number',
      exclusiveMinimum: 0,
      default: '60000',
    },
    {
      key: 'maxMessageBytes',
      label: 'Message Size Limit (bytes)',
      kind: 'number',
      exclusiveMinimum: 0,
    },
    {
      key: 'maxAttachmentBytes',
      label: 'Attachment Size Limit (bytes)',
      kind: 'number',
      exclusiveMinimum: 0,
    },
    {
      key: 'maxTextLength',
      label: 'Text Character Limit',
      kind: 'number',
      exclusiveMinimum: 0,
    },
    {
      key: 'privatePolicy',
      label: 'Private Policy',
      kind: 'enum',
      required: true,
      default: 'allowlist',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'open', label: 'Open' },
      ],
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
    { key: 'allowedUsers', label: 'Allowed Users', kind: 'string-list' },
    { key: 'operators', label: 'Session Operators', kind: 'string-list' },
  ],
};

// Derive the checked field keys from the REAL plugin descriptor (not a hand
// copy) so a newly declared Email field cannot silently escape the sweep.
// privatePolicy uses the shared label; allowedUsers/operators are shared keys
// that Email overrides with address-specific copy.
const EMAIL_MAPPED_FIELDS = [
  ...(emailPlugin.management?.fields ?? [])
    .map((f) => f.key)
    .filter((k) => k !== 'privatePolicy'),
  'allowedUsers',
  'operators',
];
const EMAIL_INSTANCE: DaemonChannelInstanceSnapshot = {
  name: 'agent-mail',
  config: {
    type: 'email',
    address: 'agent@example.com',
    imapHost: 'imap.example.com',
    imapUser: 'agent@example.com',
    smtpHost: 'smtp.example.com',
    smtpUser: 'agent@example.com',
    privatePolicy: 'allowlist',
  },
  secrets: {
    imapPassword: { present: true, source: 'environment' },
    smtpPassword: { present: true, source: 'environment' },
  },
  startsWithServe: false,
  runtime: { state: 'stopped' },
};

describe('Email channel editor', () => {
  function labelTexts(): string[] {
    return Array.from(document.querySelectorAll('label')).map(
      (label) => label.textContent ?? '',
    );
  }

  it('renders readable English labels instead of raw config keys', async () => {
    await renderDialog({ descriptor: EMAIL, instance: EMAIL_INSTANCE });

    const labels = labelTexts();
    expect(labels.some((t) => t.includes('Mailbox Address'))).toBe(true);
    expect(labels.some((t) => t.includes('IMAP Host'))).toBe(true);
    expect(labels.some((t) => t.includes('IMAP Password'))).toBe(true);
    expect(labels.some((t) => t.includes('SMTP Password'))).toBe(true);
    // The descriptor used to carry `label: key` for all seven required fields.
    // Exact match on the star-stripped label: a raw fallback renders exactly the
    // key, while a legitimate label like "Allowed email addresses" merely
    // contains "address" as a substring and must not trip the guard.
    const normalized = labels.map((t) => t.replace(/\*+$/, '').trim());
    for (const raw of [
      'address',
      'imapHost',
      'imapUser',
      'smtpHost',
      'smtpUser',
      'imapPassword',
      'smtpPassword',
    ]) {
      expect(normalized).not.toContain(raw);
    }
    expect(document.body.textContent ?? '').not.toContain(
      'Descriptor description',
    );
    expect(descriptionOf(fieldByLabel('IMAP Implicit TLS'))).toContain(
      'STARTTLS is mandatory',
    );
    expect(descriptionOf(fieldByLabel('Proactive Recipients'))).toContain(
      'Empty disables proactive email',
    );
  });

  it('renders readable zh-CN labels instead of raw config keys', async () => {
    await renderDialog({
      descriptor: EMAIL,
      instance: EMAIL_INSTANCE,
      language: 'zh-CN',
    });

    const labels = labelTexts();
    expect(labels.some((t) => t.includes('邮箱地址'))).toBe(true);
    expect(labels.some((t) => t.includes('IMAP 服务器'))).toBe(true);
    expect(labels.some((t) => t.includes('IMAP 密码'))).toBe(true);
    expect(labels.some((t) => t.includes('SMTP 密码'))).toBe(true);
    const normalized = labels.map((t) => t.replace(/\*+$/, '').trim());
    for (const raw of [
      'address',
      'imapHost',
      'imapUser',
      'smtpHost',
      'smtpUser',
      'imapPassword',
      'smtpPassword',
    ]) {
      expect(normalized).not.toContain(raw);
    }
    // getTranslator resolves messages[key] ?? EN[key] ?? key, so a zh-CN gap
    // renders the ENGLISH copy, not the descriptor. These per-locale label and
    // description assertions are therefore what pin the translation; the
    // both-locale sweep below cannot see a single-locale gap.
    expect(document.body.textContent ?? '').not.toContain(
      'Descriptor description',
    );
    expect(descriptionOf(fieldByLabel('IMAP 隐式 TLS'))).toContain(
      '关闭后必须使用 STARTTLS',
    );
    expect(descriptionOf(fieldByLabel('SMTP 隐式 TLS'))).toContain(
      '关闭后必须使用 STARTTLS',
    );
    expect(descriptionOf(fieldByLabel('主动投递收件人'))).toContain(
      '留空则禁用主动投递邮件',
    );
    expect(descriptionOf(fieldByLabel('允许的邮箱地址'))).toContain(
      '裸邮箱地址',
    );
  });

  it('renders every mapped Email label from the catalog in both locales', async () => {
    // This sweep catches a key missing from BOTH locale maps: getTranslator
    // falls back to EN before it returns the raw key, so a single-locale gap
    // renders English and stays green here — the targeted per-locale
    // assertions above pin each language. What this adds is the both-missing
    // case across the WHOLE map, where the operator would see the raw catalog
    // key as the field's label.
    // The fixture must carry every field the real plugin declares, so a new
    // plugin field cannot escape the sweep by being absent from the fixture.
    for (const key of emailPlugin.management?.fields ?? []) {
      expect(EMAIL.fields.some((f) => f.key === key.key)).toBe(true);
    }
    for (const [language, advancedLabel] of [
      ['en', 'Advanced settings'],
      ['zh-CN', '高级设置'],
    ] as const) {
      await renderDialog({
        descriptor: EMAIL,
        instance: EMAIL_INSTANCE,
        language,
      });
      await expandAdvancedSettings(advancedLabel);

      const labels = labelTexts();
      expect(
        labels.filter((text) => text.includes('channels.editor.field.')),
      ).toEqual([]);
      // Guard against a vacuous sweep: the fields must actually have rendered.
      expect(labels.length).toBeGreaterThan(15);

      // Per-key, per-locale: the catalog must actually contain the key (a
      // single-locale gap falls back to EN, which the raw-key sweep above
      // cannot see), and the rendered label must be that catalog value. This
      // is what pins each translation rather than only the both-missing case.
      const t = getTranslator(language);
      const en = getTranslator('en');
      // Pin the field->label ASSOCIATION, not just the set of strings: each
      // control's label carries htmlFor ending in the field key, so transposing
      // two catalog entries (imapUser <-> smtpUser) must go red here even though
      // both strings still appear once in the flattened list.
      for (const field of EMAIL_MAPPED_FIELDS) {
        const i18nKey = `channels.editor.field.email.${field}`;
        const catalog = t(i18nKey);
        expect(catalog).not.toBe(i18nKey);
        const label = document.querySelector(`label[for$="-${field}"]`);
        expect(label).not.toBeNull();
        // Required labels render a trailing aria-hidden asterisk.
        const text = (label?.textContent ?? '').replace(/\*+$/, '').trim();
        expect(text).toBe(catalog);
        // A zh-CN gap silently falls back to EN (rendered == catalog == EN), so
        // requiring zh != en is what pins the zh catalog entry's presence.
        if (language === 'zh-CN') expect(catalog).not.toBe(en(i18nKey));
      }
    }
  });

  it('files the mailbox endpoints under Connection, not Credentials', async () => {
    await renderDialog({ descriptor: EMAIL, instance: EMAIL_INSTANCE });

    expect(sectionHeadingOf(fieldByLabel('IMAP Host'))).toBe('Connection');
    expect(sectionHeadingOf(fieldByLabel('SMTP Host'))).toBe('Connection');
    expect(sectionHeadingOf(fieldByLabel('IMAP Port'))).toBe('Connection');
    expect(sectionHeadingOf(fieldByLabel('SMTP Port'))).toBe('Connection');
    expect(sectionHeadingOf(fieldByLabel('IMAP Implicit TLS'))).toBe(
      'Connection',
    );
    expect(sectionHeadingOf(fieldByLabel('SMTP Implicit TLS'))).toBe(
      'Connection',
    );
    expect(sectionHeadingOf(fieldByLabel('Mailbox Address'))).toBe(
      'Credentials',
    );
  });

  it('files mailbox tuning under Advanced, not Credentials', async () => {
    await renderDialog({ descriptor: EMAIL, instance: EMAIL_INSTANCE });
    await expandAdvancedSettings();

    // The polled folder and the three size caps are rarely changed tuning,
    // not credentials. Each must live in the advanced disclosure panel; if a
    // key drops out of ADVANCED_FIELD_KEYS it falls back to Credentials and
    // this assertion goes red.
    for (const label of [
      'IMAP Folder',
      'Message Size Limit (bytes)',
      'Attachment Size Limit (bytes)',
      'Text Character Limit',
    ]) {
      const control = fieldByLabel(label);
      expect(control).not.toBeNull();
      const panel = control?.closest('[data-slot="collapsible"]');
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain('Advanced settings');
      expect(sectionHeadingOf(control)).not.toBe('Credentials');
    }
  });

  it('offers no group control for a private-only channel', async () => {
    await renderDialog({ descriptor: EMAIL, instance: EMAIL_INSTANCE });

    const labels = labelTexts();
    expect(labels.some((t) => t.includes('Group policy'))).toBe(false);
    expect(labels.some((t) => t.includes('Allowed group IDs'))).toBe(false);
    expect(labels.some((t) => t.includes('Who can talk in groups'))).toBe(
      false,
    );
    // Direct-message access is still editable: only the group axis is inert.
    expect(labels.some((t) => t.includes('Direct message policy'))).toBe(true);
    // Email overrides the shared "user IDs / without pairing" copy with
    // address-specific hints, since the adapter only accepts bare mailboxes.
    expect(labels.some((t) => t.includes('Allowed email addresses'))).toBe(
      true,
    );
    expect(labels.some((t) => t.includes('Session operator addresses'))).toBe(
      true,
    );
    expect(descriptionOf(fieldByLabel('Allowed email addresses'))).toContain(
      'bare mailbox addresses',
    );
    expect(
      descriptionOf(fieldByLabel('Allowed email addresses')),
    ).not.toContain('without pairing');
  });

  it('does not resurrect group controls from a stored pairing policy', async () => {
    await renderDialog({
      descriptor: EMAIL,
      instance: {
        ...EMAIL_INSTANCE,
        config: {
          ...EMAIL_INSTANCE.config,
          groupPolicy: 'pairing',
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
        },
      },
    });

    const labels = labelTexts();
    expect(labels.some((t) => t.includes('Group policy'))).toBe(false);
    expect(labels.some((t) => t.includes('Allowed group IDs'))).toBe(false);
    // The panel's real headings are "Pending requests" / "Pairing approvals";
    // "Pairing requests" never renders, so asserting its absence was vacuous.
    expect(document.body.textContent ?? '').not.toContain('Pending requests');
    expect(document.body.textContent ?? '').not.toContain('Pairing approvals');
  });

  it('keeps the pairing panel closed when the descriptor lacks the group field', async () => {
    // The registry always injects groupPolicy today, so the stored-config
    // fallback arm of effectiveGroupPolicy is normally unreachable. Drive it
    // anyway: with the field absent from the descriptor, only the private-only
    // branch stops a stored 'pairing' from resurrecting the panel.
    const noGroupDescriptor = {
      ...EMAIL,
      fields: EMAIL.fields.filter((f) => f.key !== 'groupPolicy'),
    };
    await renderDialog({
      descriptor: noGroupDescriptor,
      instance: {
        ...EMAIL_INSTANCE,
        config: {
          ...EMAIL_INSTANCE.config,
          groupPolicy: 'pairing',
          groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
        },
      },
    });

    expect(document.body.textContent ?? '').not.toContain('Pending requests');
    expect(document.body.textContent ?? '').not.toContain('Pairing approvals');
  });

  it('offers exactly the three private policies the adapter supports', async () => {
    await renderDialog({ descriptor: EMAIL, instance: EMAIL_INSTANCE });

    const trigger = fieldByLabel('Direct message policy');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((option) => option.textContent?.trim());
    expect(options).toEqual(['Disabled', 'Allowlist', 'Open']);
  });

  it('renders proactive recipients as a comma-separated text input', async () => {
    await renderDialog({ descriptor: EMAIL, instance: EMAIL_INSTANCE });

    const input = inputByLabel('Proactive Recipients');
    expect(input).not.toBeNull();
    expect(input!.type).toBe('text');
    expect(
      document.querySelectorAll(
        '[role="group"][aria-label="Proactive Recipients"]',
      ).length,
    ).toBe(0);
  });

  it('saves without writing a group policy', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await renderDialog({
      descriptor: EMAIL,
      instance: EMAIL_INSTANCE,
      onSave,
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => save?.click());

    expect(onSave).toHaveBeenCalledTimes(1);
    const request = onSave.mock.calls[0]![1] as {
      config: Record<string, unknown>;
      secrets: Record<string, { operation: string }>;
    };
    expect(request.config).not.toHaveProperty('groupPolicy');
    expect(request.config).not.toHaveProperty('groups');
    expect(request.config['privatePolicy']).toBe('allowlist');
    expect(request.secrets['imapPassword']).toEqual({ operation: 'preserve' });
    expect(request.secrets['smtpPassword']).toEqual({ operation: 'preserve' });
  });

  it('leaves the group controls on a group-capable sibling', async () => {
    await renderDialog({ descriptor: DINGTALK_WITH_ACCESS });

    const labels = labelTexts();
    expect(labels.some((t) => t.includes('Group policy'))).toBe(true);
  });
});

describe('QR bind inside the editor', () => {
  it('closes the editor on a successful bind so the stale draft cannot unbind it', async () => {
    // The draft is seeded from the pre-bind instance. Leaving the editor open
    // would let the next Save submit the old empty credentials, which the
    // upsert maps to a secret clear — silently undoing the bind.
    const qqDescriptor: DaemonChannelTypeDescriptor = {
      type: 'qq',
      displayName: 'QQ',
      manageable: true,
      supportsQrLogin: true,
      fields: [
        { key: 'appID', label: 'App ID', kind: 'string' },
        { key: 'appSecret', label: 'App Secret', kind: 'secret' },
      ],
    };
    const instance = {
      name: 'qq-bot',
      config: { type: 'qq' },
      secrets: { appSecret: { present: false } },
      startsWithServe: false,
      runtime: { state: 'stopped' as const },
    };
    const pending = {
      loginId: 'login-1',
      channelType: 'qq',
      channelName: 'qq-bot',
      status: 'pending' as const,
      expiresAt: 9_999_999,
      qrCodeDataUrl: 'data:image/png;base64,AAAA',
    };
    const onOpenChange = vi.fn();
    const onReload = vi.fn().mockResolvedValue(undefined);
    const qrLoginActions = {
      start: vi.fn().mockResolvedValue({ ...pending, attached: false }),
      state: vi.fn().mockResolvedValue({
        ...pending,
        status: 'succeeded' as const,
        qrCodeDataUrl: undefined,
      }),
      cancel: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    };
    vi.useFakeTimers();
    try {
      await renderDialog({
        descriptor: qqDescriptor,
        instance: instance as never,
        qrLoginActions,
        onOpenChange,
        onReload,
      });
      const scan = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Scan to bind'),
      );
      expect(scan).toBeDefined();
      await act(async () => {
        scan!.click();
      });
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(onReload).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the login when the real dialog closes', async () => {
    // The panel's release hangs off unmount, so the premise needs exercising:
    // a host that owns `open`, closed through the dialog's own Cancel button.
    // If the dialog ever keeps its content mounted on close, this goes red.
    const qqDescriptor: DaemonChannelTypeDescriptor = {
      type: 'qq',
      displayName: 'QQ',
      manageable: true,
      supportsQrLogin: true,
      fields: [
        { key: 'appID', label: 'App ID', kind: 'string' },
        { key: 'appSecret', label: 'App Secret', kind: 'secret' },
      ],
    };
    const instance = {
      name: 'qq-bot',
      config: { type: 'qq' },
      secrets: { appSecret: { present: false } },
      startsWithServe: false,
      runtime: { state: 'stopped' as const },
    };
    const pending = {
      loginId: 'login-1',
      channelType: 'qq',
      channelName: 'qq-bot',
      status: 'pending' as const,
      expiresAt: 9_999_999,
      qrCodeDataUrl: 'data:image/png;base64,AAAA',
    };
    const qrLoginActions = {
      start: vi.fn().mockResolvedValue({ ...pending, attached: false }),
      state: vi.fn().mockResolvedValue(pending),
      cancel: vi.fn().mockResolvedValue({ ...pending, status: 'cancelled' }),
      release: vi.fn().mockResolvedValue(undefined),
    };

    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <I18nProvider language="en">
          <ChannelEditorDialog
            open={open}
            descriptor={qqDescriptor}
            instance={instance as never}
            expectedRevision="revision-1"
            existingNames={[]}
            workspaces={WORKSPACES}
            workspaceCwd="/workspace/main"
            onWorkspaceChange={vi.fn()}
            onOpenChange={setOpen}
            onSave={vi.fn().mockResolvedValue(undefined)}
            onReload={vi.fn().mockResolvedValue(undefined)}
            qrLoginActions={qrLoginActions}
            listPairingRequests={vi.fn().mockResolvedValue({ requests: [] })}
            approvePairingRequest={vi.fn()}
            listPairingApprovals={vi.fn().mockResolvedValue({ senderIds: [] })}
            revokePairingApproval={vi.fn()}
          />
        </I18nProvider>
      );
    }

    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(<Host />);
      });
      const scan = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Scan to bind'),
      );
      expect(scan).toBeDefined();
      await act(async () => {
        scan!.click();
      });
      expect(qrLoginActions.cancel).not.toHaveBeenCalled();

      // The footer Cancel is the last button carrying that label; the panel's
      // own Cancel comes earlier in the tree.
      const cancels = [...document.querySelectorAll('button')].filter((b) =>
        b.textContent?.includes('Cancel'),
      );
      expect(cancels.length).toBeGreaterThan(0);
      await act(async () => {
        cancels[cancels.length - 1]!.click();
      });

      expect(qrLoginActions.cancel).toHaveBeenCalledWith('login-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
