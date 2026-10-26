// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedExtensionCatalog,
  ManagedExtensionSnapshot,
} from './managed-extension-types';
import { I18nProvider } from '../../i18n';
import { ManagedExtensionsManagerPage } from './ManagedExtensionsManagerPage';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';

vi.mock('../../daemon-react-sdk', () => ({
  useOptionalWorkspace: () => undefined,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
const pin = {
  extensionId: 'ext_00000000-0000-4000-8000-000000000001',
  packageRevision: 1,
  packageDigest: 'a'.repeat(64),
};
const catalog: ManagedExtensionCatalog = {
  supported: true,
  extensions: [
    {
      pin,
      manifest: {
        schemaVersion: 1,
        compilerVersion: 1,
        name: 'Example',
        version: '1',
        target: { platform: 'linux', arch: 'x64' },
        components: ['skills'],
      },
    },
  ],
};

function snapshot(sessionId: string): ManagedExtensionSnapshot {
  return {
    sessionId,
    supported: true,
    revision: 1,
    extensions: [pin],
    requestedExtensions: [pin],
  };
}
function provider() {
  const extensions = {
    storageScope: 'test',
    list: vi.fn(async () => catalog),
    query: vi.fn(async (id: string) => snapshot(id)),
    apply: vi.fn(),
    resume: vi.fn(),
    publish: vi.fn(),
    settings: vi.fn(async () => ({ settingsRevision: 5, configuredKeys: [] })),
    saveSettings: vi.fn(),
  };
  return {
    extensions,
    value: { extensions } as unknown as ManagedAgentProvider,
  };
}
async function render(value: ManagedAgentProvider, sessionId = 'session-a') {
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ManagedExtensionsManagerPage
          provider={value}
          workspaceId="workspace"
          sessionId={sessionId}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
}
async function ready() {
  await vi.waitFor(() =>
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Example"]')
        ?.disabled,
    ).toBe(false),
  );
}
beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

it('limits checkbox and saved-settings additions to 32 selected packages', async () => {
  const target = provider();
  const entries = Array.from({ length: 33 }, (_, index) => ({
    ...catalog.extensions[0]!,
    pin: {
      ...pin,
      extensionId: `ext_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    },
    manifest: {
      ...catalog.extensions[0]!.manifest,
      name: `Package ${index + 1}`,
    },
  }));
  target.extensions.list.mockResolvedValue({ ...catalog, extensions: entries });
  target.extensions.query.mockImplementation(async (id) => ({
    ...snapshot(id),
    extensions: entries.slice(0, 32).map((entry) => entry.pin),
    requestedExtensions: entries.slice(0, 32).map((entry) => entry.pin),
  }));
  await render(target.value);
  const last = () =>
    container.querySelector<HTMLInputElement>('[aria-label="Package 33"]')!;
  await vi.waitFor(() => expect(last()).toBeDefined());
  expect(last().disabled).toBe(true);
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>('button'),
  ].filter((item) => item.textContent === 'Settings');
  await act(async () => buttons.at(-1)!.click());
  const useSettings = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === 'Use saved settings revision 5',
    )!;
  await vi.waitFor(() => expect(useSettings()).toBeDefined());
  expect(useSettings().disabled).toBe(true);
  const close = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((item) => item.textContent === 'Close')!;
  await act(async () => close.click());
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Package 1"]')!
      .click(),
  );
  expect(last().disabled).toBe(false);
  await act(async () => last().click());
  expect(last().checked).toBe(true);
  expect(
    [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].filter((item) => item.checked),
  ).toHaveLength(32);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Managed extension selection', () => {
  it('preserves an explicitly empty pending selection while old packages remain active', async () => {
    const target = provider();
    target.extensions.query.mockImplementation(async (id) => ({
      ...snapshot(id),
      requestedExtensions: [],
      operation: {
        operationId: '00000000-0000-4000-8000-000000000001',
        state: 'recovery_required',
        mode: 'apply',
        revision: 2,
      },
    }));
    await render(target.value);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Recovery blocked'),
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Example"]')
        ?.checked,
    ).toBe(false);
    expect(target.extensions.apply).not.toHaveBeenCalled();
  });

  it('aborts the previous target and discards its late response', async () => {
    const target = provider();
    let resolveOld!: (value: ManagedExtensionSnapshot) => void;
    target.extensions.query.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render(target.value);
    await render(target.value, 'session-b');
    await ready();
    const oldSignal = target.extensions.query.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(oldSignal?.signal?.aborted).toBe(true);
    await act(async () =>
      resolveOld({ ...snapshot('session-a'), requestedExtensions: [] }),
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Example"]')
        ?.checked,
    ).toBe(true);
  });

  it('retries an unknown apply with the original selection and idempotency key', async () => {
    const target = provider();
    target.extensions.apply
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(snapshot('session-a'));
    await render(target.value);
    await ready();
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[aria-label="Example"]')!
        .click(),
    );
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find(
        (item) => item.textContent === label,
      )!;
    await act(async () => button('Apply selection').click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Retry original request'),
    );
    await act(async () => button('Retry original request').click());
    await vi.waitFor(() =>
      expect(target.extensions.apply).toHaveBeenCalledTimes(2),
    );
    expect(target.extensions.apply.mock.calls[0]?.slice(0, 2)).toEqual(
      target.extensions.apply.mock.calls[1]?.slice(0, 2),
    );
    expect(target.extensions.apply.mock.calls[0]?.[2].idempotencyKey).toBe(
      target.extensions.apply.mock.calls[1]?.[2].idempotencyKey,
    );
  });

  it('keeps the exact settings revision when selecting a newer package', async () => {
    const target = provider();
    target.extensions.list.mockResolvedValue({
      ...catalog,
      extensions: catalog.extensions.map((entry) => ({
        ...entry,
        pin: { ...pin, packageRevision: 2, packageDigest: 'b'.repeat(64) },
      })),
    });
    target.extensions.query.mockImplementation(async (id) => ({
      ...snapshot(id),
      extensions: [{ ...pin, settingsRevision: 5 }],
      requestedExtensions: [{ ...pin, settingsRevision: 5 }],
    }));
    target.extensions.apply.mockResolvedValue(snapshot('session-a'));
    await render(target.value);
    await ready();
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find(
        (item) => item.textContent === label,
      )!;
    await act(async () => button('Update selected extension').click());
    await act(async () => button('Apply selection').click());
    await vi.waitFor(() => expect(target.extensions.apply).toHaveBeenCalled());
    expect(target.extensions.apply.mock.calls[0]?.[1]).toEqual({
      expectedConfigRevision: 1,
      extensions: [
        {
          ...pin,
          packageRevision: 2,
          packageDigest: 'b'.repeat(64),
          settingsRevision: 5,
        },
      ],
    });
  });
});

it('refreshes and unlocks a definitive stale-revision rejection for a new request', async () => {
  const target = provider();
  target.extensions.apply.mockRejectedValue(
    new JavaManagedAgentHttpError(
      409,
      'extension_config_revision_conflict',
      'Refresh current configuration',
    ),
  );
  target.extensions.query
    .mockResolvedValueOnce(snapshot('session-a'))
    .mockResolvedValue({ ...snapshot('session-a'), revision: 2 });
  await render(target.value);
  await ready();
  const checkbox = () =>
    container.querySelector<HTMLInputElement>('[aria-label="Example"]')!;
  await act(async () => checkbox().click());
  const apply = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Apply selection',
  )!;
  await act(async () => apply.click());
  await vi.waitFor(() =>
    expect(target.extensions.apply).toHaveBeenCalledTimes(1),
  );
  await vi.waitFor(() =>
    expect(target.extensions.query).toHaveBeenCalledTimes(2),
  );
  expect(checkbox().disabled).toBe(false);
  expect(container.textContent).not.toContain('Retry original request');
  expect(
    sessionStorage.getItem('managed-extension-apply:test:workspace:session-a'),
  ).toBeNull();
  target.extensions.apply.mockResolvedValueOnce(snapshot('session-a'));
  await act(async () => checkbox().click());
  await act(async () => apply.click());
  expect(
    target.extensions.apply.mock.calls[1]?.[1].expectedConfigRevision,
  ).toBe(2);
  expect(target.extensions.apply.mock.calls[1]?.[2].idempotencyKey).not.toBe(
    target.extensions.apply.mock.calls[0]?.[2].idempotencyKey,
  );
});

it.each([
  new JavaManagedAgentHttpError(
    409,
    'hosted_extension_configuration_conflict',
    'Commit conflict',
  ),
  new JavaManagedAgentHttpError(
    503,
    'session_config_outcome_unknown',
    'Query original operation',
  ),
])(
  'preserves an original apply when admission or commit is uncertain: $code',
  async (error) => {
    const target = provider();
    target.extensions.apply
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(snapshot('session-a'));
    await render(target.value);
    await ready();
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find(
        (item) => item.textContent === label,
      )!;
    await act(async () => button('Apply selection').click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Retry original request'),
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Example"]')!
        .disabled,
    ).toBe(true);
    await act(async () => button('Retry original request').click());
    expect(target.extensions.apply.mock.calls[1]?.[2].idempotencyKey).toBe(
      target.extensions.apply.mock.calls[0]?.[2].idempotencyKey,
    );
  },
);
