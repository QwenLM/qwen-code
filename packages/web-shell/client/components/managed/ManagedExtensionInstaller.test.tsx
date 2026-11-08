// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedExtensionInspection,
  ManagedExtensionSnapshot,
  ManagedExtensionSelection,
} from './managed-extension-types';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { createManagedExtensionInstall } from './managed-extension-install';
import {
  ManagedExtensionInstaller,
  buildManagedMcpInput,
} from './ManagedExtensionInstaller';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const pin = {
  extensionId: 'ext_00000000-0000-4000-8000-000000000001',
  packageRevision: 1,
  packageDigest: 'a'.repeat(64),
};
const snapshot: ManagedExtensionSnapshot = {
  sessionId: 'session',
  supported: true,
  revision: 4,
  extensions: [],
  requestedExtensions: [],
  selfService: { supported: true, canApply: true },
};
const catalog = {
  supported: true,
  extensions: [],
  selfService: { supported: true, canPublish: true },
};
const inspection: ManagedExtensionInspection = {
  manifest: {
    schemaVersion: 1,
    compilerVersion: 1,
    name: 'docs',
    version: '1',
    target: { platform: 'linux', arch: 'x64' },
    components: ['mcp', 'settings'],
  },
  fileCount: 1,
  files: ['qwen-extension.json'],
  truncated: false,
  skills: [],
  mcpServers: [
    { name: 'docs', recipe: { command: 'node', args: [] }, redacted: false },
  ],
  settings: [{ name: 'TOKEN', envVar: 'TOKEN', sensitive: true }],
};
const published = {
  operationId: 'published',
  extensionId: pin.extensionId,
  kind: 'publish',
  state: 'settled',
  revision: 1,
  packageDigest: pin.packageDigest,
};
const missing = async () => {
  throw new JavaManagedAgentHttpError(404, 'not_found', 'Missing');
};
let container: HTMLDivElement;
let root: Root;
const arrayBuffer = Object.getOwnPropertyDescriptor(
  Blob.prototype,
  'arrayBuffer',
);
beforeEach(() => {
  sessionStorage.clear();
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value() {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(this);
      });
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (arrayBuffer)
    Object.defineProperty(Blob.prototype, 'arrayBuffer', arrayBuffer);
  else Reflect.deleteProperty(Blob.prototype, 'arrayBuffer');
});
function api() {
  return {
    storageScope: 'scope',
    query: vi.fn(async () => snapshot),
    previewPackage: vi.fn(async () => inspection),
    importPackage: vi.fn(async () => published),
    lookupPackageOperation: vi.fn(missing),
    lookupApplyOperation: vi.fn(missing),
    settings: vi.fn(async () => ({ settingsRevision: 0, configuredKeys: [] })),
    saveSettings: vi.fn(async () => ({
      ...published,
      kind: 'settings',
      revision: 2,
    })),
    apply: vi.fn(
      async (
        _session: string,
        selection: ManagedExtensionSelection,
        _options?: { idempotencyKey?: string },
      ) => ({
        ...snapshot,
        extensions: selection.extensions,
        requestedExtensions: selection.extensions,
        revision: 5,
        operation: {
          operationId: '00000000-0000-4000-8000-000000000002',
          state: 'active',
          mode: 'apply',
          revision: 5,
        },
      }),
    ),
  };
}
async function render(
  client: ReturnType<typeof api>,
  key = 'initial',
  kind: 'skill' | 'mcp' = 'mcp',
  onInstalled = vi.fn(),
  editor: {
    editing?: { extensionId: string; inspection: ManagedExtensionInspection };
    onExitEdit?: () => void;
  } = {},
) {
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ManagedExtensionInstaller
          key={key}
          provider={
            {
              storageKey: 'provider',
              extensions: client,
            } as unknown as ManagedAgentProvider
          }
          workspaceId="workspace"
          sessionId="session"
          catalog={catalog}
          snapshot={snapshot}
          initialKind={kind}
          onChanged={vi.fn()}
          onInstalled={onInstalled}
          {...editor}
        />
      </I18nProvider>,
    ),
  );
}
async function edit(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === name,
  )!;

it('reviews actual package contents without publication, then installs once while keeping secrets out of the source and journal', async () => {
  const client = api();
  const onInstalled = vi.fn();
  await render(client, 'initial', 'mcp', onInstalled);
  await edit('Name (optional for archives)', 'docs');
  await edit('Executable command', 'node');
  await edit('Secret setting names, separated by commas', 'TOKEN');
  await edit('TOKEN', 'private-token');
  expect(button('Install into current session').disabled).toBe(true);
  await act(async () => {
    button('Review package').click();
    await vi.waitFor(() =>
      expect(client.previewPackage).toHaveBeenCalledOnce(),
    );
  });
  expect(client.previewPackage).toHaveBeenCalledOnce();
  expect(client.importPackage).not.toHaveBeenCalled();
  expect(onInstalled).not.toHaveBeenCalled();
  expect(
    container.querySelector('[data-managed-package-preview]')?.textContent,
  ).toContain('qwen-extension.json');
  expect(button('Install into current session').disabled).toBe(false);
  await act(async () => {
    button('Install into current session').click();
    await vi.waitFor(() => expect(client.apply).toHaveBeenCalledOnce());
  });
  expect(client.importPackage).toHaveBeenCalledOnce();
  expect(client.saveSettings).toHaveBeenCalledWith(
    'workspace',
    pin.extensionId,
    0,
    { TOKEN: 'private-token' },
    expect.any(Object),
  );
  expect(client.apply).toHaveBeenCalledWith(
    'session',
    {
      expectedConfigRevision: 4,
      extensions: [{ ...pin, settingsRevision: 2 }],
    },
    expect.any(Object),
  );
  expect(container.textContent).toContain('Installed in the selected session');
  expect(onInstalled).toHaveBeenCalledOnce();
  expect(
    sessionStorage.getItem('managed-extension-install:scope:workspace:session'),
  ).toBeNull();
  const source = client.importPackage.mock.calls[0]?.[3] as unknown as Blob;
  expect(new TextDecoder().decode(await source.arrayBuffer())).not.toContain(
    'private-token',
  );
});

it('keeps editing when apply has not become active', async () => {
  const client = api();
  client.previewPackage.mockResolvedValue({ ...inspection, settings: [] });
  client.apply.mockImplementation(async (_session, selection) => ({
    ...snapshot,
    requestedExtensions: selection.extensions,
    operation: {
      operationId: '00000000-0000-4000-8000-000000000002',
      state: 'recovery_required',
      mode: 'apply',
      revision: 5,
    },
  }));
  const onInstalled = vi.fn();
  await render(client, 'initial', 'mcp', onInstalled);
  await edit('Name (optional for archives)', 'docs');
  await edit('Executable command', 'node');
  await act(async () => {
    button('Review package').click();
    await vi.waitFor(() =>
      expect(client.previewPackage).toHaveBeenCalledOnce(),
    );
  });
  await act(async () => {
    button('Install into current session').click();
    await vi.waitFor(() => expect(client.apply).toHaveBeenCalledOnce());
  });
  expect(onInstalled).not.toHaveBeenCalled();
  expect(
    sessionStorage.getItem('managed-extension-install:scope:workspace:session'),
  ).toContain('apply');
});

it('restores a publication receipt after reload without repeating the upload or requiring the lost source', async () => {
  const client = api();
  client.previewPackage.mockResolvedValue({ ...inspection, settings: [] });
  client.importPackage.mockRejectedValueOnce(new Error('response lost'));
  await render(client);
  await edit('Name (optional for archives)', 'docs');
  await edit('Executable command', 'node');
  await act(async () => {
    button('Review package').click();
    await vi.waitFor(() =>
      expect(client.previewPackage).toHaveBeenCalledOnce(),
    );
  });
  await act(async () => {
    button('Install into current session').click();
    await vi.waitFor(() => expect(client.importPackage).toHaveBeenCalledOnce());
  });
  const saved = sessionStorage.getItem(
    'managed-extension-install:scope:workspace:session',
  )!;
  expect(saved).toContain('sourceDigest');
  expect(saved).not.toContain('"command"');
  client.lookupPackageOperation.mockResolvedValue(published as never);
  await render(client, 'reloaded');
  await act(async () => {
    button('Retry original request').click();
    await vi.waitFor(() => expect(client.apply).toHaveBeenCalledOnce());
  });
  expect(client.importPackage).toHaveBeenCalledOnce();
  expect(client.apply).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Installed in the selected session');
});

it('preserves an original journal behind an explicit exit from editing', async () => {
  const client = api();
  const original = {
    ...createManagedExtensionInstall(
      {
        workspaceId: 'workspace',
        sessionId: 'session',
        metadata: {
          sourceKind: 'mcp',
          target: { platform: 'linux', arch: 'x64' },
          sourceDigest: 'b'.repeat(64),
          compilerVersion: 1,
        },
        expectedSettingsRevision: 0,
        settingsKeys: [],
      },
      snapshot,
    ),
    stage: 'apply',
    pin,
    applySubmitted: true,
  };
  const key = 'managed-extension-install:scope:workspace:session';
  const stored = JSON.stringify(original);
  sessionStorage.setItem(key, stored);
  const onInstalled = vi.fn();
  const onExitEdit = vi.fn();
  await render(client, 'editor', 'mcp', onInstalled, {
    editing: { extensionId: 'ext_other', inspection },
    onExitEdit,
  });
  expect(container.textContent).toContain(
    'An earlier installation requires recovery',
  );
  expect(container.querySelector('input')).toBeNull();
  expect(client.lookupApplyOperation).not.toHaveBeenCalled();
  expect(client.apply).not.toHaveBeenCalled();
  expect(onInstalled).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe(stored);
  await act(async () => button('cancel').click());
  expect(onExitEdit).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem(key)).toBe(stored);

  await render(client, 'original', 'mcp', onInstalled);
  await act(async () => button('Retry original request').click());
  expect(client.apply).toHaveBeenCalledOnce();
  expect(client.apply.mock.calls[0]?.[2]?.idempotencyKey).toBe(
    original.applyKey,
  );
  expect(onInstalled).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem(key)).toBeNull();
});

it('invalidates review when the configuration changes', async () => {
  const client = api();
  await render(client);
  await edit('Name (optional for archives)', 'docs');
  await edit('Executable command', 'node');
  await act(async () => {
    button('Review package').click();
    await vi.waitFor(() =>
      expect(client.previewPackage).toHaveBeenCalledOnce(),
    );
  });
  await edit('Executable command', 'different-command');
  expect(button('Install into current session').disabled).toBe(true);
  expect(client.importPackage).not.toHaveBeenCalled();
});

it.each([
  ['streamable-http', 'http'],
  ['sse', 'sse'],
])(
  'serializes the %s form using the %s Managed recipe transport',
  async (transport, wireType) => {
    const source = buildManagedMcpInput({
      name: 'docs',
      serverName: 'docs',
      transport,
      command: '',
      args: '[]',
      url: 'https://mcp.example/mcp',
      environment: '{}',
      headers: '{}',
      secretKeys: [],
    });
    const document = JSON.parse(
      new TextDecoder().decode(await source.arrayBuffer()),
    );
    expect(document.recipe).toEqual({
      url: 'https://mcp.example/mcp',
      headers: {},
      type: wireType,
    });
  },
);

it('requires known credential headers to contain only the declared secret reference', () => {
  const input = {
    name: 'docs',
    serverName: 'docs',
    transport: 'streamable-http',
    command: '',
    args: '[]',
    url: 'https://mcp.example',
    environment: '{}',
    headers: JSON.stringify({
      Authorization: 'Bearer literal-secret ${TOKEN}',
    }),
    secretKeys: ['TOKEN'],
  };
  expect(() => buildManagedMcpInput(input)).toThrow('Credential headers');
  expect(() =>
    buildManagedMcpInput({
      ...input,
      headers: JSON.stringify({ Authorization: 'Bearer ${TOKEN}' }),
    }),
  ).not.toThrow();
});

it('installs a reviewed Skill archive without requiring personal authorization for the v2 preparation contract', async () => {
  const client = api();
  client.previewPackage.mockResolvedValue({
    ...inspection,
    manifest: { ...inspection.manifest, name: 'pdf', components: ['skills'] },
    files: ['skills/pdf/SKILL.md', 'skills/pdf/scripts/check.py'],
    fileCount: 2,
    mcpServers: [],
    settings: [],
    skills: [{ name: 'pdf:pdf', description: 'PDF tools' }],
  });
  await render(client, 'skill', 'skill');
  const file = new File(['archive-bytes'], 'pdf.zip', {
    type: 'application/zip',
  });
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  await act(async () => {
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    button('Review package').click();
    await vi.waitFor(() =>
      expect(client.previewPackage).toHaveBeenCalledOnce(),
    );
  });
  expect(container.textContent).toContain('skills/pdf/scripts/check.py');
  await act(async () => {
    button('Install into current session').click();
    await vi.waitFor(() => expect(client.apply).toHaveBeenCalledOnce());
  });
  expect(client.importPackage).toHaveBeenCalledWith(
    'workspace',
    undefined,
    expect.objectContaining({ sourceKind: 'skill', compilerVersion: 2 }),
    file,
    expect.any(Object),
  );
  expect(container.textContent).toContain('Installed in the selected session');
});

it.each(['X-Auth-Token', 'X-Custom-Credential'])(
  'requires a declared placeholder for credential headers regardless of name (%s)',
  (header) => {
    const input = {
      name: 'docs',
      serverName: 'docs',
      transport: 'streamable-http',
      command: '',
      args: '[]',
      url: 'https://mcp.example/mcp',
      environment: '{}',
      headers: JSON.stringify({ [header]: 'fixture-private-token' }),
      secretKeys: ['TOKEN'],
    };
    expect(() => buildManagedMcpInput(input)).toThrow('Credential headers');
    expect(() =>
      buildManagedMcpInput({
        ...input,
        headers: JSON.stringify({ [header]: '${TOKEN}' }),
      }),
    ).not.toThrow();
    expect(() =>
      buildManagedMcpInput({
        ...input,
        headers: '{}',
        environment: JSON.stringify({ CUSTOM_TOKEN: 'fixture-private-token' }),
      }),
    ).toThrow('settings placeholders');
  },
);
