import type { ChannelPlugin } from '@qwen-code/channel-base';
import { plugin as telegramPlugin } from '@qwen-code/channel-telegram';
import { plugin as weixinPlugin } from '@qwen-code/channel-weixin';
import { plugin as dingtalkPlugin } from '@qwen-code/channel-dingtalk';

const registry = new Map<string, ChannelPlugin>();

// Register built-in channel types
for (const p of [telegramPlugin, weixinPlugin, dingtalkPlugin]) {
  registry.set(p.channelType, p);
}

export function registerPlugin(plugin: ChannelPlugin): void {
  if (registry.has(plugin.channelType)) {
    throw new Error(
      `Channel type "${plugin.channelType}" is already registered.`,
    );
  }
  registry.set(plugin.channelType, plugin);
}

export function getPlugin(channelType: string): ChannelPlugin | undefined {
  return registry.get(channelType);
}

export function supportedTypes(): string[] {
  return [...registry.keys()];
}
