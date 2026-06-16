import type { ChannelPlugin } from '@qwen-code/channel-base';

const registry = new Map<string, ChannelPlugin>();
let builtinsPromise: Promise<void> | null = null;

function ensureBuiltins(): Promise<void> {
  if (!builtinsPromise) {
    builtinsPromise = (async () => {
      const results = await Promise.allSettled([
        import('@qwen-code/channel-telegram'),
        import('@qwen-code/channel-weixin'),
        import('@qwen-code/channel-dingtalk'),
        import('@qwen-code/channel-feishu'),
        import('@qwen-code/channel-qqbot'),
      ]);

      for (const result of results) {
        if (result.status === 'fulfilled') {
          registry.set(result.value.plugin.channelType, result.value.plugin);
        } else {
          process.stderr.write(
            `[channel-registry] Failed to load a built-in channel: ${result.reason}\n`,
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
