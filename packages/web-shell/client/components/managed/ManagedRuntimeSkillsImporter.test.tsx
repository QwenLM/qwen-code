// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type { ManagedExtensionSelection } from './managed-extension-types';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { ManagedRuntimeSkillsImporter } from './ManagedRuntimeSkillsImporter';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const owner = { bindingId: 'binding', generation: '2' };
const pin = {
  extensionId: 'ext_00000000-0000-4000-8000-000000000001',
  packageRevision: 1,
  packageDigest: 'a'.repeat(64),
};
const target = { platform: 'linux' as const, arch: 'x64' as const };
const snapshot = {
  sessionId: 'session',
  supported: true,
  revision: 4,
  extensions: [],
  requestedExtensions: [],
  selfService: {
    supported: true,
    canApply: true,
    runtimeSkillImportSupported: true,
  },
};
const catalog = {
  supported: true,
  extensions: [],
  selfService: { supported: true, canPublish: true },
};
const prepared = {
  sessionId: 'session',
  owner,
  operationId: '00000000-0000-4000-8000-000000000003',
  preparationId: '00000000-0000-4000-8000-000000000004',
  sourceDigest: 'b'.repeat(64),
  byteLength: 42,
  target,
  inspection: {
    manifest: {
      schemaVersion: 1,
      compilerVersion: 1,
      name: 'pdf',
      version: '1',
      target,
      components: ['skills'],
    },
    fileCount: 1,
    files: ['skills/pdf/SKILL.md'],
    truncated: false,
    skills: [{ name: 'pdf:pdf', description: 'PDF tools' }],
    mcpServers: [],
    settings: [],
  },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const missing = async () => {
  throw new JavaManagedAgentHttpError(404, 'not_found', 'Missing');
};
function api() {
  return {
    storageScope: 'scope',
    query: vi.fn(async () => snapshot),
    runtimeSkillCandidates: vi.fn(async () => ({
      sessionId: 'session',
      owner,
      candidates: [
        {
          name: 'pdf',
          description: 'PDF tools',
          path: '.qwen/skills/pdf',
          digest: 'c'.repeat(64),
          shadowed: false,
          compatible: true,
        },
      ],
    })),
    runtimeSkillSnapshot: vi.fn(async () => prepared),
    importRuntimeSkill: vi.fn(async () => ({
      operationId: 'publication',
      extensionId: pin.extensionId,
      kind: 'publish',
      state: 'settled',
      revision: 1,
      packageDigest: pin.packageDigest,
    })),
    lookupPackageOperation: vi.fn(missing),
    lookupApplyOperation: vi.fn(missing),
    apply: vi.fn(
      async (_session: string, selection: ManagedExtensionSelection) => ({
        ...snapshot,
        revision: 5,
        extensions: selection.extensions,
        requestedExtensions: selection.extensions,
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
async function render(client: ReturnType<typeof api>, supported = true) {
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ManagedRuntimeSkillsImporter
          provider={
            {
              storageKey: 'provider',
              extensions: client,
            } as unknown as ManagedAgentProvider
          }
          workspaceId="workspace"
          sessionId="session"
          catalog={catalog}
          snapshot={{
            ...snapshot,
            selfService: {
              ...snapshot.selfService,
              runtimeSkillImportSupported: supported,
            },
          }}
          onChanged={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
}
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === name,
  )!;
async function scan() {
  await act(async () => button('Scan current Runtime').click());
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type=radio]')!.click(),
  );
}

it('keeps discovery passive and confirms an exact owner-bound snapshot before importing and applying', async () => {
  const client = api();
  await render(client);
  expect(client.runtimeSkillCandidates).not.toHaveBeenCalled();
  await scan();
  expect(client.importRuntimeSkill).not.toHaveBeenCalled();
  await act(async () => button('Review package').click());
  expect(client.runtimeSkillSnapshot).toHaveBeenCalledWith(
    'session',
    { owner, path: '.qwen/skills/pdf', digest: 'c'.repeat(64), target },
    expect.any(Object),
  );
  expect(container.textContent).toContain('skills/pdf/SKILL.md');
  await act(async () => button('Install into current session').click());
  const { inspection: _inspection, ...reference } = prepared;
  expect(client.importRuntimeSkill).toHaveBeenCalledWith(
    'session',
    reference,
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  );
  expect(client.apply).toHaveBeenCalledWith(
    'session',
    { expectedConfigRevision: 4, extensions: [pin] },
    expect.any(Object),
  );
  expect(container.textContent).toContain('Installed in the selected session');
});

it('rejects a changed Runtime owner without importing or rescanning automatically', async () => {
  const client = api();
  client.runtimeSkillSnapshot.mockResolvedValue({
    ...prepared,
    owner: { ...owner, generation: '3' },
  });
  await render(client);
  await scan();
  await act(async () => button('Review package').click());
  expect(client.runtimeSkillCandidates).toHaveBeenCalledOnce();
  expect(client.importRuntimeSkill).not.toHaveBeenCalled();
  expect(button('Install into current session').disabled).toBe(true);
  expect(container.textContent).toContain(
    'Runtime source could not be confirmed',
  );
});

it('does not expose or invoke discovery for an unqualified execution profile', async () => {
  const client = api();
  await render(client, false);
  expect(container.querySelector('[data-managed-runtime-skills]')).toBeNull();
  expect(client.runtimeSkillCandidates).not.toHaveBeenCalled();
});

it.each(['failed', 'revision conflict'])(
  're-reviews %s with a fresh apply key without republishing the Runtime snapshot',
  async (failure) => {
    const client = api();
    const failed = {
      ...snapshot,
      operation: {
        operationId: '00000000-0000-4000-8000-000000000002',
        state: 'failed',
        mode: 'apply',
        revision: 5,
      },
    };
    if (failure === 'failed')
      client.apply.mockResolvedValueOnce(failed as never);
    else
      client.apply.mockRejectedValueOnce(
        new JavaManagedAgentHttpError(
          409,
          'extension_config_revision_conflict',
          'Conflict',
        ),
      );
    await render(client);
    await scan();
    await act(async () => button('Review package').click());
    await act(async () => button('Install into current session').click());
    const key = 'managed-runtime-skill-install:scope:workspace:session';
    const original = JSON.parse(sessionStorage.getItem(key)!);
    expect(original.applySubmitted).toBe(false);
    client.query.mockResolvedValue({ ...snapshot, revision: 6 });
    client.lookupApplyOperation.mockImplementation(
      async (...args: unknown[]) => {
        if (failure === 'failed' && args[1] === original.applyKey)
          return failed as never;
        return missing();
      },
    );
    await act(async () => button('Review current selection').click());
    const reviewed = JSON.parse(sessionStorage.getItem(key)!);
    expect(reviewed.expectedConfigRevision).toBe(6);
    expect(reviewed.applyKey).not.toBe(original.applyKey);
    for (const field of ['publishKey', 'settingsKey', 'pin', 'runtimeSnapshot'])
      expect(reviewed[field]).toEqual(original[field]);
    client.apply.mockImplementation(async (_session, selection) => ({
      ...snapshot,
      revision: 7,
      extensions: selection.extensions,
      requestedExtensions: selection.extensions,
      operation: { ...failed.operation, state: 'active', revision: 7 },
    }));
    await act(async () => button('Retry original request').click());
    expect(client.apply.mock.calls[1][1].expectedConfigRevision).toBe(6);
    expect(client.importRuntimeSkill).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(key)).toBeNull();
  },
);

it('keeps an unknown submitted Runtime apply on its original key when lookup returns 404', async () => {
  const client = api();
  client.apply.mockRejectedValueOnce(new TypeError('Response lost'));
  await render(client);
  await scan();
  await act(async () => button('Review package').click());
  await act(async () => button('Install into current session').click());
  const key = 'managed-runtime-skill-install:scope:workspace:session';
  const original = sessionStorage.getItem(key)!;
  expect(JSON.parse(original).applySubmitted).toBe(true);
  client.query.mockClear();
  await act(async () => button('Review current selection').click());
  expect(sessionStorage.getItem(key)).toBe(original);
  expect(client.query).not.toHaveBeenCalled();
  expect(client.apply).toHaveBeenCalledOnce();
});
