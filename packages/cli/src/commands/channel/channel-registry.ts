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
const RESERVED_FIELD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
  path = field.key,
  nested = false,
): void {
  if (RESERVED_FIELD_KEYS.has(field.key)) {
    throw new Error(`Channel field "${path}" cannot use a reserved key.`);
  }
  const envResolvable =
    (field as { envResolvable?: unknown }).envResolvable === true;
  const required = (field as { required?: unknown }).required === true;
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
          try {
            assertManagementDescriptor(result.value.plugin);
            registry.set(result.value.plugin.channelType, result.value.plugin);
          } catch (error) {
            process.stderr.write(
              `[channel-registry] Invalid management metadata in "${labelled[i]!.name}" channel: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
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
  assertManagementDescriptor(plugin);
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
