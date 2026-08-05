import type {
  ChannelConfigFieldDescriptor,
  ChannelPlugin,
} from '@qwen-code/channel-base';

export interface ChannelTypeDescriptor {
  type: string;
  displayName: string;
  manageable: boolean;
  fields: readonly ChannelConfigFieldDescriptor[];
}

const registry = new Map<string, ChannelPlugin>();
let builtinsPromise: Promise<void> | null = null;
export const UNSAFE_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function assertManagementFields(
  fields: readonly ChannelConfigFieldDescriptor[],
  parentPath?: string,
  nested = false,
): void {
  const seen = new Set<string>();
  for (const field of fields) {
    const path = parentPath ? `${parentPath}.${field.key}` : field.key;
    if (seen.has(field.key)) {
      throw new Error(`Channel field "${path}" is declared more than once.`);
    }
    seen.add(field.key);
    assertManagementField(field, path, nested);
  }
}

function assertManagementField(
  field: ChannelConfigFieldDescriptor,
  path: string,
  nested: boolean,
): void {
  if (UNSAFE_OBJECT_KEYS.has(field.key)) {
    throw new Error(`Channel field "${path}" cannot use a reserved key.`);
  }
  const envResolvable = field.envResolvable === true;
  const required = field.required === true;
  if (field.kind === 'secret' && nested) {
    throw new Error(`Channel field "${path}" cannot declare a nested secret.`);
  }
  if (envResolvable && nested) {
    throw new Error(
      `Channel field "${path}" cannot resolve environment references.`,
    );
  }
  if (field.kind !== 'object') return;
  if (required) {
    throw new Error(`Channel field "${path}" cannot be a required object.`);
  }
  if (envResolvable) {
    throw new Error(
      `Channel field "${path}" cannot resolve environment references.`,
    );
  }
  assertManagementFields(field.properties ?? [], path, true);
}

function assertManagementDescriptor(plugin: ChannelPlugin): void {
  assertManagementFields(plugin.management?.fields ?? []);
}

function ensureBuiltins(): Promise<void> {
  if (!builtinsPromise) {
    builtinsPromise = (async () => {
      const labelled = [
        { name: 'telegram', promise: import('@qwen-code/channel-telegram') },
        { name: 'weixin', promise: import('@qwen-code/channel-weixin') },
        { name: 'dingtalk', promise: import('@qwen-code/channel-dingtalk') },
        { name: 'wecom', promise: import('@qwen-code/channel-wecom') },
        { name: 'feishu', promise: import('@qwen-code/channel-feishu') },
        { name: 'qqbot', promise: import('@qwen-code/channel-qqbot') },
        { name: 'github', promise: import('@qwen-code/channel-github') },
        { name: 'gitlab', promise: import('@qwen-code/channel-gitlab') },
      ];

      const results = await Promise.allSettled(labelled.map((l) => l.promise));

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === 'fulfilled') {
          registerWithManagementValidation(
            result.value.plugin,
            labelled[i]!.name,
          );
        } else {
          process.stderr.write(
            `[channel-registry] Failed to load "${labelled[i]!.name}" channel: ${result.reason}\n`,
          );
        }
      }
    })();
  }
  return builtinsPromise;
}

export function registerPlugin(plugin: ChannelPlugin): void {
  if (registry.has(plugin.channelType)) {
    throw new Error(
      `Channel type "${plugin.channelType}" is already registered.`,
    );
  }
  registerWithManagementValidation(plugin, plugin.channelType);
}

function registerWithManagementValidation(
  plugin: ChannelPlugin,
  label: string,
): void {
  try {
    assertManagementDescriptor(plugin);
  } catch (error) {
    // Fail closed on the management surface only; the channel runtime keeps
    // working with management stripped.
    process.stderr.write(
      `[channel-registry] Invalid management metadata in "${label}" channel: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    registry.set(plugin.channelType, { ...plugin, management: undefined });
    return;
  }
  registry.set(plugin.channelType, plugin);
}

export async function getPlugin(
  channelType: string,
): Promise<ChannelPlugin | undefined> {
  await ensureBuiltins();
  return registry.get(channelType);
}

export async function supportedTypes(): Promise<string[]> {
  await ensureBuiltins();
  return [...registry.keys()];
}

export async function supportedChannelCatalog(): Promise<
  ChannelTypeDescriptor[]
> {
  await ensureBuiltins();
  return [...registry.values()].map(
    ({ channelType, displayName, management }) => ({
      type: channelType,
      displayName,
      manageable: management !== undefined,
      fields: management?.fields ?? [],
    }),
  );
}
