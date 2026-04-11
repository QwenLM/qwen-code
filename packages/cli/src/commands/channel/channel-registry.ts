import type { ChannelPlugin } from '@qwen-code/channel-base';

const registry = new Map<string, ChannelPlugin>();
let builtinsLoaded = false;

async function ensureBuiltins(): Promise<void> {
  if (builtinsLoaded) return;
  builtinsLoaded = true;

  const [telegram, weixin, dingtalk] = await Promise.all([
    import('@qwen-code/channel-telegram'),
    import('@qwen-code/channel-weixin'),
    import('@qwen-code/channel-dingtalk'),
  ]);

  for (const mod of [telegram, weixin, dingtalk]) {
    registry.set(mod.plugin.channelType, mod.plugin);
  }
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
