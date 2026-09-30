import type { ChannelBase } from '@qwen-code/channel-base';

interface DisconnectChannelsOptions {
  timeoutMs?: number;
  onTimeout?: () => void;
}

export async function disconnectChannels(
  channels: Iterable<ChannelBase>,
  options: DisconnectChannelsOptions = {},
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
  const draining = Promise.all(drains).then(() => undefined);
  const timeoutMs = options.timeoutMs;
  if (timeoutMs === undefined) {
    await draining;
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(
          () => {
            options.onTimeout?.();
            resolve();
          },
          Math.max(0, timeoutMs),
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
