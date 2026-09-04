import type { ChannelBase } from '@qwen-code/channel-base';

export async function disconnectChannels(
  channels: Iterable<ChannelBase>,
): Promise<void> {
  const drains: Array<Promise<void>> = [];
  for (const channel of channels) {
    try {
      channel.disconnect();
    } catch {
      // best-effort
    }
    try {
      const drain = channel.waitForDisconnect?.();
      if (drain) drains.push(drain.catch(() => undefined));
    } catch {
      // best-effort
    }
  }
  await Promise.all(drains);
}
