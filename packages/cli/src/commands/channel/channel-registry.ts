import type {
  ChannelConfigFieldDescriptor,
  ChannelPlugin,
  SessionScope,
} from '@qwen-code/channel-base';

export interface ChannelTypeDescriptor {
  type: string;
  displayName: string;
  manageable: boolean;
  fields: readonly ChannelConfigFieldDescriptor[];
}

const registry = new Map<string, ChannelPlugin>();
let builtinsPromise: Promise<void> | null = null;

const SESSION_SCOPE_OPTIONS: ReadonlyArray<{
  value: SessionScope;
  label: string;
}> = [
  { value: 'user', label: 'Per user and chat' },
  { value: 'thread', label: 'Per thread' },
  { value: 'chat_thread', label: 'Per chat and thread' },
  { value: 'single', label: 'One shared session' },
];

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
  return [...registry.values()].map((plugin) => {
    const { channelType, displayName, management } = plugin;
    const fields = management?.fields ?? [];
    return {
      type: channelType,
      displayName,
      manageable: management !== undefined,
      fields:
        management && !fields.some((field) => field.key === 'sessionScope')
          ? [
              ...fields,
              {
                key: 'sessionScope',
                label: 'Session scope',
                kind: 'enum',
                required: true,
                default: plugin.defaultSessionScope ?? 'user',
                description:
                  'Controls which incoming conversations share one agent session.',
                options: SESSION_SCOPE_OPTIONS,
              },
            ]
          : fields,
    };
  });
}
