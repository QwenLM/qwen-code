import { describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedExtensionPackageOperation,
  ManagedExtensionSnapshot,
} from './managed-extension-types';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import {
  continueManagedExtensionInstall,
  createManagedExtensionInstall,
  managedExtensionSourceDigest,
  parseManagedExtensionInstall,
  isManagedExtensionInstallActive,
} from './managed-extension-install';

const pin = {
  extensionId: 'ext_00000000-0000-4000-8000-000000000001',
  packageRevision: 2,
  packageDigest: 'a'.repeat(64),
};
const other = {
  ...pin,
  extensionId: 'ext_00000000-0000-4000-8000-000000000002',
};
const snapshot: ManagedExtensionSnapshot = {
  sessionId: 'session',
  supported: true,
  revision: 7,
  extensions: [other],
  requestedExtensions: [other],
};
const active: ManagedExtensionSnapshot = {
  ...snapshot,
  revision: 8,
  extensions: [other, pin],
  requestedExtensions: [other, pin],
  operation: {
    operationId: '00000000-0000-4000-8000-000000000003',
    state: 'active',
    mode: 'apply',
    revision: 8,
  },
};
const publication: ManagedExtensionPackageOperation = {
  operationId: 'publish',
  extensionId: pin.extensionId,
  kind: 'publish',
  state: 'settled',
  revision: pin.packageRevision,
  packageDigest: pin.packageDigest,
};
const missing = () =>
  Promise.reject(new JavaManagedAgentHttpError(404, 'not_found', 'Not found'));

function api() {
  return {
    importPackage: vi.fn(async () => publication),
    lookupPackageOperation: vi.fn(missing),
    lookupApplyOperation: vi.fn(missing),
    saveSettings: vi.fn(async () => ({
      ...publication,
      kind: 'settings',
      revision: 3,
    })),
    apply: vi.fn(async () => active),
    resume: vi.fn(async () => active),
  };
}
type Api = ReturnType<typeof api>;
const asManagement = (value: Api) =>
  value as unknown as NonNullable<ManagedAgentProvider['extensions']>;
async function command(settingsKeys: string[] = []) {
  const source = new Blob(['original archive']);
  return {
    source,
    value: createManagedExtensionInstall(
      {
        workspaceId: 'workspace',
        sessionId: 'session',
        metadata: {
          sourceKind: 'skill',
          target: { platform: 'linux', arch: 'x64' },
          sourceDigest: await managedExtensionSourceDigest(source),
          compilerVersion: 1,
        },
        expectedSettingsRevision: 0,
        settingsKeys,
      },
      snapshot,
    ),
  };
}

describe('Managed installation receipts', () => {
  it('merges one package into the frozen selection and stores no input or credential values', async () => {
    const client = api();
    const input = await command(['API_TOKEN']);
    const journal: unknown[] = [];
    await continueManagedExtensionInstall(
      asManagement(client),
      input.value,
      input.source,
      { API_TOKEN: 'never-store-this' },
      { clientId: 'client' },
      (value) => journal.push(value),
    );
    expect(client.importPackage).toHaveBeenCalledOnce();
    expect(client.saveSettings).toHaveBeenCalledWith(
      'workspace',
      pin.extensionId,
      0,
      { API_TOKEN: 'never-store-this' },
      expect.objectContaining({ idempotencyKey: input.value.settingsKey }),
    );
    expect(client.apply).toHaveBeenCalledWith(
      'session',
      {
        expectedConfigRevision: 7,
        extensions: [other, { ...pin, settingsRevision: 3 }],
      },
      expect.objectContaining({ idempotencyKey: input.value.applyKey }),
    );
    expect(JSON.stringify(journal)).not.toContain('never-store-this');
    expect(JSON.stringify(journal)).not.toContain('original archive');
  });

  it('recovers settled publication and settings after lost responses without repeating writes', async () => {
    const client = api();
    client.lookupPackageOperation.mockImplementation(
      async (_workspace?: unknown, kind?: unknown) => ({
        ...publication,
        kind: String(kind),
        revision: kind === 'settings' ? 5 : 2,
      }),
    );
    const input = await command(['TOKEN']);
    await continueManagedExtensionInstall(
      asManagement(client),
      input.value,
      undefined,
      undefined,
      { clientId: 'client' },
      vi.fn(),
    );
    expect(client.importPackage).not.toHaveBeenCalled();
    expect(client.saveSettings).not.toHaveBeenCalled();
    expect(client.apply.mock.calls[0]?.[1]).toEqual({
      expectedConfigRevision: 7,
      extensions: [other, { ...pin, settingsRevision: 5 }],
    });
  });

  it('queries and continues the original pending apply instead of resubmitting it', async () => {
    const client = api();
    const input = await command();
    input.value.pin = pin;
    input.value.stage = 'apply';
    client.lookupApplyOperation.mockResolvedValue({
      ...active,
      operation: { ...active.operation!, state: 'recovery_required' },
    } as never);
    await continueManagedExtensionInstall(
      asManagement(client),
      input.value,
      undefined,
      undefined,
      { clientId: 'client' },
      vi.fn(),
    );
    expect(client.resume).toHaveBeenCalledWith(
      'session',
      active.operation!.operationId,
      false,
      { clientId: 'client' },
    );
    expect(client.apply).not.toHaveBeenCalled();
  });

  it('does not mutate when lookup fails or the reselected input differs', async () => {
    const client = api();
    const input = await command();
    client.lookupPackageOperation.mockRejectedValueOnce(
      new Error('unavailable'),
    );
    await expect(
      continueManagedExtensionInstall(
        asManagement(client),
        input.value,
        input.source,
        undefined,
        { clientId: 'client' },
        vi.fn(),
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      continueManagedExtensionInstall(
        asManagement(client),
        input.value,
        new Blob(['changed']),
        undefined,
        { clientId: 'client' },
        vi.fn(),
      ),
    ).rejects.toThrow('changed');
    expect(client.importPackage).not.toHaveBeenCalled();
    expect(client.apply).not.toHaveBeenCalled();
  });

  it('stops before settings or apply when the selected target is aborted after publication', async () => {
    const client = api();
    const input = await command(['TOKEN']);
    const abort = new AbortController();
    client.importPackage.mockImplementation(async () => {
      abort.abort();
      return publication;
    });
    await expect(
      continueManagedExtensionInstall(
        asManagement(client),
        input.value,
        input.source,
        { TOKEN: 'value' },
        { clientId: 'client', signal: abort.signal },
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(client.saveSettings).not.toHaveBeenCalled();
    expect(client.apply).not.toHaveBeenCalled();
  });

  it('preserves personal authorization bindings in version 2 updates', async () => {
    const input = await command();
    const bindings = [
      {
        serverId: `${other.extensionId}:tools`,
        credentialId: 'credential',
        credentialGeneration: 2,
      },
    ];
    const value = createManagedExtensionInstall(
      {
        workspaceId: 'workspace',
        sessionId: 'session',
        metadata: input.value.metadata,
        expectedSettingsRevision: 0,
        settingsKeys: [],
      },
      { ...snapshot, selectionVersion: 2, mcpAuthBindings: bindings },
    );
    value.pin = pin;
    value.stage = 'apply';
    const client = api();
    await continueManagedExtensionInstall(
      asManagement(client),
      value,
      undefined,
      undefined,
      { clientId: 'client' },
      vi.fn(),
    );
    expect(client.apply.mock.calls[0]?.[1]).toEqual({
      selectionVersion: 2,
      expectedConfigRevision: 7,
      extensions: [other, pin],
      mcpAuthBindings: bindings,
    });
  });

  it('accepts only scoped, public journal fields', async () => {
    const input = await command(['TOKEN']);
    expect(
      parseManagedExtensionInstall(
        JSON.stringify(input.value),
        'workspace',
        'session',
      ),
    ).toEqual(input.value);
    expect(
      parseManagedExtensionInstall(
        JSON.stringify(input.value),
        'workspace',
        'another-session',
      ),
    ).toBeUndefined();
    expect(
      parseManagedExtensionInstall(
        JSON.stringify({ ...input.value, secretValues: { TOKEN: 'secret' } }),
        'workspace',
        'session',
      ),
    ).toBeUndefined();
    expect(
      parseManagedExtensionInstall(
        JSON.stringify({
          ...input.value,
          metadata: { ...input.value.metadata, recipe: { token: 'secret' } },
        }),
        'workspace',
        'session',
      ),
    ).toBeUndefined();
  });

  it('publishes a frozen Runtime snapshot without reading a local source', async () => {
    const input = await command();
    input.value.runtimeSnapshot = {
      sessionId: 'session',
      owner: { bindingId: 'binding', generation: '2' },
      operationId: 'operation',
      preparationId: 'prepared',
      sourceDigest: input.value.metadata.sourceDigest,
      byteLength: 42,
      target: input.value.metadata.target,
    };
    expect(
      parseManagedExtensionInstall(
        JSON.stringify(input.value),
        'workspace',
        'session',
      ),
    ).toEqual(input.value);
    const client = {
      ...api(),
      importRuntimeSkill: vi.fn(async () => publication),
    };
    await continueManagedExtensionInstall(
      client as unknown as NonNullable<ManagedAgentProvider['extensions']>,
      input.value,
      undefined,
      undefined,
      { clientId: 'client' },
      vi.fn(),
    );
    expect(client.importRuntimeSkill).toHaveBeenCalledWith(
      'session',
      input.value.runtimeSnapshot,
      expect.objectContaining({ idempotencyKey: input.value.publishKey }),
    );
    expect(client.importPackage).not.toHaveBeenCalled();
  });

  it('does not call restored content installed merely because recovery is active', async () => {
    const input = await command();
    input.value.pin = pin;
    expect(isManagedExtensionInstallActive(input.value, active)).toBe(true);
    expect(
      isManagedExtensionInstallActive(input.value, {
        ...active,
        operation: { ...active.operation!, mode: 'recoverPrevious' },
      }),
    ).toBe(false);
    expect(
      isManagedExtensionInstallActive(input.value, {
        ...active,
        extensions: [other],
      }),
    ).toBe(false);
  });
});
