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
const { I18nProvider } = await import('../../i18n');

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

    const instructions = fieldByLabel('Instructions');
    const endpoint = fieldByLabel('API endpoint (descriptor)');

    expect(instructions?.tagName).toBe('TEXTAREA');
    expect(endpoint?.tagName).toBe('INPUT');
  });

  it('groups the shared instructions control with conversation management', async () => {
    await renderDialog({ descriptor: MULTILINE_INSTRUCTIONS });

    // `instructions` is not a credential: it is stored in clear text and
    // injected into the session context, so it belongs with the other shared
    // session controls rather than in the catch-all credentials panel.
    expect(sectionHeadingOf(fieldByLabel('Instructions'))).toBe(
      'Conversation management',
    );
    expect(sectionHeadingOf(fieldByLabel('API endpoint (descriptor)'))).toBe(
      'Credentials',
    );
  });

  it('renders the localized instructions copy above the textarea instead of the descriptor literal', async () => {
    await renderDialog({ descriptor: MULTILINE_INSTRUCTIONS });

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

  it('localizes the instructions copy for zh-CN operators', async () => {
    await renderDialog({
      descriptor: MULTILINE_INSTRUCTIONS,
      language: 'zh-CN',
    });

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

  it('separates connection and notification fields from credentials', async () => {
    await renderDialog({ descriptor: GITHUB_CONFIGURED });

    expect(sectionHeadingOf(fieldByLabel('Base URL'))).toBe('Connection');
    expect(sectionHeadingOf(fieldByLabel('Reason Filter'))).toBe(
      'Notifications and routing',
    );
    expect(sectionHeadingOf(inputByLabel('Personal Access Token'))).toBe(
      'Credentials',
    );
    expect(inputByLabel('Base URL')?.placeholder).toBe(
      'https://ghe.example.com/api/v3',
    );
  });

  it('splits connection and routing fields for a non-GitHub channel', async () => {
    await renderDialog({ descriptor: GITLAB_ROUTING });

    expect(sectionHeadingOfLabel('Instance URL')).toBe('Connection');
    expect(sectionHeadingOfLabel('Personal Access Token')).toBe('Credentials');
    expect(sectionHeadingOfLabel('Message Routes')).toBe(
      'Notifications and routing',
    );
    expect(sectionHeadingOfLabel('Default Message Route')).toBe(
      'Notifications and routing',
    );
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

  it('renders the poll interval under Connection', async () => {
    await renderDialog({ descriptor: GITHUB_POLLING });

    expect(sectionHeadingOfLabel('Poll Interval (ms)')).toBe('Connection');
    expect(inputByLabel('Poll Interval (ms)')?.type).toBe('number');
  });

  it('files the poll interval under Connection for any platform declaring it', async () => {
    // The section map is keyed by field name, so Email's existing interval
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

    expect(sectionHeadingOfLabel('Poll Interval (ms)')).toBe('Connection');
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

    expect(inputByLabel('轮询间隔（毫秒）')).not.toBeNull();
    expect(sectionHeadingOfLabel('轮询间隔（毫秒）')).toBe('连接');
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
    await act(async () => {
      setInputValue(inputByLabel('Poll Interval (ms)')!, '2592000000');
    });
    await save();

    expect(document.body.textContent).toContain(
      'Enter a number greater than 0 and at most 86400000.',
    );
  });
});
