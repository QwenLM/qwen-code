import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type {
  ManagedAgentProvider,
  ManagedAgentRequestOptions,
} from './managed-agent-provider';
import type {
  ManagedExtensionImportMetadata,
  ManagedExtensionPackageOperation,
  ManagedExtensionPin,
  ManagedExtensionSnapshot,
  ManagedMcpAuthBinding,
  ManagedRuntimeSkillImport,
} from './managed-extension-types';
import {
  isManagedExtensionPins,
  isManagedMcpAuthBindings,
  managedExtensionSelection,
} from './managed-extension-types';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { managedRequestId } from './managed-session-storage';

type Management = NonNullable<ManagedAgentProvider['extensions']>;

export interface ManagedExtensionInstallCommand {
  version: 1;
  workspaceId: string;
  sessionId: string;
  metadata: ManagedExtensionImportMetadata;
  extensionId?: string;
  expectedConfigRevision: number;
  extensions: ManagedExtensionPin[];
  expectedSettingsRevision: number;
  settingsKeys: string[];
  keepSettingsRevision?: number;
  publishKey: string;
  settingsKey: string;
  applyKey: string;
  stage: 'publish' | 'settings' | 'apply';
  pin?: ManagedExtensionPin;
  selectionVersion?: 2;
  mcpAuthBindings?: ManagedMcpAuthBinding[];
  requiresOAuth?: boolean;
  runtimeSnapshot?: ManagedRuntimeSkillImport;
  applySubmitted?: boolean;
}

export class ManagedExtensionInstallInputRequired extends Error {
  constructor(readonly input: 'source' | 'settings') {
    super(`The original ${input} input is required.`);
  }
}

export class ManagedExtensionInstallAuthorizationRequired extends Error {
  constructor() {
    super(
      'Personal MCP authorization is required before applying this package.',
    );
  }
}

export async function managedExtensionSourceDigest(source: Blob) {
  if (source.size > 100 * 1024 * 1024)
    throw new Error('Managed package exceeds 100 MiB');
  return bytesToHex(sha256(new Uint8Array(await source.arrayBuffer())));
}

export function createManagedExtensionInstall(
  input: Pick<
    ManagedExtensionInstallCommand,
    | 'workspaceId'
    | 'sessionId'
    | 'metadata'
    | 'extensionId'
    | 'expectedSettingsRevision'
    | 'settingsKeys'
    | 'keepSettingsRevision'
    | 'requiresOAuth'
    | 'runtimeSnapshot'
  >,
  snapshot: ManagedExtensionSnapshot,
): ManagedExtensionInstallCommand {
  if (snapshot.sessionId !== input.sessionId)
    throw new Error('The installation target changed.');
  const key = managedRequestId();
  return {
    ...input,
    metadata: structuredClone(input.metadata),
    settingsKeys: [...input.settingsKeys].sort(),
    version: 1,
    expectedConfigRevision: snapshot.revision,
    extensions: structuredClone(snapshot.extensions),
    publishKey: `${key}:publish`,
    settingsKey: `${key}:settings`,
    applyKey: `${key}:apply`,
    stage: 'publish',
    ...(snapshot.selectionVersion === 2
      ? {
          selectionVersion: 2,
          mcpAuthBindings: structuredClone(snapshot.mcpAuthBindings ?? []),
        }
      : {}),
  };
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

export function parseManagedExtensionInstall(
  raw: string,
  workspaceId: string,
  sessionId: string,
): ManagedExtensionInstallCommand | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const command = value as ManagedExtensionInstallCommand;
    const metadata = command.metadata;
    if (
      Object.keys(command).some(
        (key) =>
          ![
            'version',
            'workspaceId',
            'sessionId',
            'metadata',
            'extensionId',
            'expectedConfigRevision',
            'extensions',
            'expectedSettingsRevision',
            'settingsKeys',
            'keepSettingsRevision',
            'publishKey',
            'settingsKey',
            'applyKey',
            'stage',
            'pin',
            'selectionVersion',
            'mcpAuthBindings',
            'requiresOAuth',
            'runtimeSnapshot',
            'applySubmitted',
          ].includes(key),
      ) ||
      command.version !== 1 ||
      command.workspaceId !== workspaceId ||
      command.sessionId !== sessionId ||
      !safeInteger(command.expectedConfigRevision) ||
      !safeInteger(command.expectedSettingsRevision) ||
      !isManagedExtensionPins(command.extensions) ||
      !['publish', 'settings', 'apply'].includes(command.stage) ||
      [command.publishKey, command.settingsKey, command.applyKey].some(
        (key) => typeof key !== 'string' || !/^[\w:-]{1,512}$/.test(key),
      ) ||
      !Array.isArray(command.settingsKeys) ||
      command.settingsKeys.length > 128 ||
      command.settingsKeys.some(
        (key) =>
          typeof key !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key),
      ) ||
      new Set(command.settingsKeys).size !== command.settingsKeys.length ||
      (command.keepSettingsRevision !== undefined &&
        !safeInteger(command.keepSettingsRevision, 1)) ||
      (command.extensionId !== undefined &&
        !/^ext_[a-f0-9-]{36}$/.test(command.extensionId)) ||
      (command.pin !== undefined && !isManagedExtensionPins([command.pin])) ||
      (command.requiresOAuth !== undefined &&
        typeof command.requiresOAuth !== 'boolean') ||
      (command.applySubmitted !== undefined &&
        typeof command.applySubmitted !== 'boolean')
    )
      return;
    if (command.runtimeSnapshot !== undefined) {
      const source = command.runtimeSnapshot;
      if (
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        Object.keys(source).some(
          (key) =>
            ![
              'sessionId',
              'owner',
              'operationId',
              'preparationId',
              'sourceDigest',
              'byteLength',
              'target',
            ].includes(key),
        ) ||
        source.sessionId !== sessionId ||
        !source.owner ||
        typeof source.owner !== 'object' ||
        Object.keys(source.owner).sort().join(',') !== 'bindingId,generation' ||
        typeof source.owner.bindingId !== 'string' ||
        !source.owner.bindingId ||
        typeof source.owner.generation !== 'string' ||
        !/^\d+$/.test(source.owner.generation) ||
        typeof source.operationId !== 'string' ||
        !/^[\w:-]{1,256}$/.test(source.operationId) ||
        typeof source.preparationId !== 'string' ||
        !/^[\w:-]{1,256}$/.test(source.preparationId) ||
        source.sourceDigest !== metadata.sourceDigest ||
        !safeInteger(source.byteLength) ||
        source.byteLength > 100 * 1024 * 1024 ||
        JSON.stringify(source.target) !== JSON.stringify(metadata.target)
      )
        return;
    }
    if (
      (command.selectionVersion !== undefined &&
        command.selectionVersion !== 2) ||
      (command.selectionVersion === 2 &&
        !isManagedMcpAuthBindings(command.mcpAuthBindings)) ||
      (command.selectionVersion === undefined &&
        command.mcpAuthBindings !== undefined)
    )
      return;
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.keys(metadata).some(
        (key) =>
          ![
            'sourceKind',
            'target',
            'sourceDigest',
            'compilerVersion',
            'packageName',
          ].includes(key),
      ) ||
      !['skill', 'extension', 'mcp'].includes(metadata.sourceKind) ||
      ![1, 2].includes(metadata.compilerVersion) ||
      !/^[a-f0-9]{64}$/.test(metadata.sourceDigest) ||
      !metadata.target ||
      typeof metadata.target !== 'object' ||
      Object.keys(metadata.target).sort().join(',') !== 'arch,platform' ||
      !['linux', 'darwin'].includes(metadata.target.platform) ||
      !['x64', 'arm64', 'any'].includes(metadata.target.arch) ||
      (metadata.packageName !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metadata.packageName))
    )
      return;
    if (command.stage === 'apply' && command.applySubmitted === undefined)
      command.applySubmitted = true;
    return command;
  } catch {
    return;
  }
}

async function lookup<T>(request: () => Promise<T>): Promise<T | undefined> {
  try {
    return await request();
  } catch (cause) {
    if (cause instanceof JavaManagedAgentHttpError && cause.status === 404)
      return;
    throw cause;
  }
}

function packagePin(operation: ManagedExtensionPackageOperation) {
  const pin = {
    extensionId: operation.extensionId,
    packageRevision: operation.revision,
    packageDigest: operation.packageDigest,
  };
  if (operation.state !== 'settled' || !isManagedExtensionPins([pin]))
    throw new Error('The package publication has not settled.');
  return pin as ManagedExtensionPin;
}

export function isManagedExtensionInstallActive(
  command: ManagedExtensionInstallCommand,
  snapshot: ManagedExtensionSnapshot,
) {
  if (
    !command.pin ||
    snapshot.operation?.state !== 'active' ||
    snapshot.operation.mode !== 'apply'
  )
    return false;
  const expected = [
    ...command.extensions.filter(
      (pin) => pin.extensionId !== command.pin!.extensionId,
    ),
    command.pin,
  ];
  if (
    snapshot.extensions.length !== expected.length ||
    !expected.every((pin) =>
      snapshot.extensions.some(
        (entry) =>
          entry.extensionId === pin.extensionId &&
          entry.packageRevision === pin.packageRevision &&
          entry.packageDigest === pin.packageDigest &&
          entry.settingsRevision === pin.settingsRevision,
      ),
    )
  )
    return false;
  return (
    command.selectionVersion !== 2 ||
    (snapshot.selectionVersion === 2 &&
      (snapshot.mcpAuthBindings ?? []).length ===
        (command.mcpAuthBindings ?? []).length &&
      (command.mcpAuthBindings ?? []).every((binding) =>
        snapshot.mcpAuthBindings?.some(
          (entry) =>
            entry.serverId === binding.serverId &&
            entry.credentialId === binding.credentialId &&
            entry.credentialGeneration === binding.credentialGeneration,
        ),
      ))
  );
}

export async function continueManagedExtensionInstall(
  management: Management,
  input: ManagedExtensionInstallCommand,
  source: Blob | undefined,
  settings: Record<string, string> | undefined,
  options: ManagedAgentRequestOptions,
  progress: (command: ManagedExtensionInstallCommand) => void,
  authorize?: (
    command: ManagedExtensionInstallCommand,
  ) => Promise<ManagedExtensionInstallCommand>,
): Promise<ManagedExtensionSnapshot> {
  if (
    (!management.importPackage && !management.importRuntimeSkill) ||
    !management.lookupPackageOperation ||
    !management.lookupApplyOperation
  )
    throw new Error('Managed installation is unavailable.');
  let command = structuredClone(input);
  const save = (change: Partial<ManagedExtensionInstallCommand>) => {
    options.signal?.throwIfAborted();
    command = { ...command, ...change };
    progress(command);
  };
  if (!command.pin) {
    options.signal?.throwIfAborted();
    let published = await lookup(() =>
      management.lookupPackageOperation!(
        command.workspaceId,
        'publish',
        command.publishKey,
        options,
      ),
    );
    if (published?.state !== 'settled') {
      if (command.runtimeSnapshot) {
        if (!management.importRuntimeSkill)
          throw new Error('Runtime Skill import is unavailable.');
        options.signal?.throwIfAborted();
        published = await management.importRuntimeSkill(
          command.sessionId,
          {
            ...command.runtimeSnapshot,
            ...(command.extensionId
              ? { extensionId: command.extensionId }
              : {}),
          },
          { ...options, idempotencyKey: command.publishKey },
        );
      } else {
        if (!source || !management.importPackage)
          throw new ManagedExtensionInstallInputRequired('source');
        if (
          (await managedExtensionSourceDigest(source)) !==
          command.metadata.sourceDigest
        )
          throw new Error('The original package input has changed.');
        options.signal?.throwIfAborted();
        published = await management.importPackage(
          command.workspaceId,
          command.extensionId,
          command.metadata,
          source,
          { ...options, idempotencyKey: command.publishKey },
        );
      }
    }
    save({ pin: packagePin(published), stage: 'settings' });
  }
  if (command.stage === 'settings') {
    if (
      command.settingsKeys.length &&
      command.keepSettingsRevision === undefined
    ) {
      let saved = await lookup(() =>
        management.lookupPackageOperation!(
          command.workspaceId,
          'settings',
          command.settingsKey,
          options,
        ),
      );
      if (saved?.state !== 'settled') {
        if (
          !settings ||
          command.settingsKeys.some((key) => !Object.hasOwn(settings, key))
        )
          throw new ManagedExtensionInstallInputRequired('settings');
        options.signal?.throwIfAborted();
        saved = await management.saveSettings(
          command.workspaceId,
          command.pin!.extensionId,
          command.expectedSettingsRevision,
          Object.fromEntries(
            command.settingsKeys.map((key) => [key, settings[key]!]),
          ),
          { ...options, idempotencyKey: command.settingsKey },
        );
      }
      if (saved.state !== 'settled' || !safeInteger(saved.revision, 1))
        throw new Error('The settings operation has not settled.');
      save({ pin: { ...command.pin!, settingsRevision: saved.revision } });
    } else if (command.keepSettingsRevision !== undefined) {
      save({
        pin: {
          ...command.pin!,
          settingsRevision: command.keepSettingsRevision,
        },
      });
    }
    save({ stage: 'apply', applySubmitted: false });
  }
  const existing = await lookup(() =>
    management.lookupApplyOperation!(
      command.sessionId,
      command.applyKey,
      options,
    ),
  );
  options.signal?.throwIfAborted();
  if (existing?.operation) {
    if (['active', 'failed'].includes(existing.operation.state))
      return existing;
    return management.resume(
      command.sessionId,
      existing.operation.operationId,
      false,
      options,
    );
  }
  if (authorize) {
    command = await authorize(command);
    options.signal?.throwIfAborted();
    progress(command);
  }
  const pins = command.extensions.filter(
    (pin) => pin.extensionId !== command.pin!.extensionId,
  );
  if (pins.length >= 32)
    throw new Error('The Session package limit has been reached.');
  const extensions = [...pins, command.pin!];
  const selection = managedExtensionSelection(
    {
      revision: command.expectedConfigRevision,
      selectionVersion: command.selectionVersion,
      mcpAuthBindings: command.mcpAuthBindings,
      extensions: authorize ? extensions : command.extensions,
    },
    extensions,
  );
  save({
    applySubmitted: true,
    ...(selection.selectionVersion === 2
      ? { mcpAuthBindings: selection.mcpAuthBindings }
      : {}),
  });
  return management.apply(command.sessionId, selection, {
    ...options,
    idempotencyKey: command.applyKey,
  });
}
