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

function assertManagementField(
  field: ChannelConfigFieldDescriptor,
  path = field.key,
  nested = false,
): void {
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
  for (const property of field.properties ?? []) {
    assertManagementField(property, `${path}.${property.key}`, true);
  }
}

function assertManagementDescriptor(plugin: ChannelPlugin): void {
  for (const field of plugin.management?.fields ?? []) {
    assertManagementField(field);
  }
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
          assertManagementDescriptor(result.value.plugin);
          registry.set(result.value.plugin.channelType, result.value.plugin);
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
