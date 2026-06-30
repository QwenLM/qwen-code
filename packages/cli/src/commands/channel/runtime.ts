import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Storage } from '@qwen-code/qwen-code-core';
import type {
  SessionRouter,
  ChannelAgentBridge,
  ChannelBase,
  ChannelPlugin,
  ToolCallEvent,
} from '@qwen-code/channel-base';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { loadSettings, type LoadedSettings } from '../../config/settings.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { getExtensionManager } from '../extensions/utils.js';
import { getPlugin, registerPlugin } from './channel-registry.js';
import { parseChannelConfig } from './config-utils.js';

export type ParsedChannelConfig = Awaited<
  ReturnType<typeof parseChannelConfig>
>;

export interface ParsedChannel {
  name: string;
  config: ParsedChannelConfig;
}

export function sessionsPath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'channels', 'sessions.json');
}

export function loadChannelsConfig(
  cwd: string = process.cwd(),
  settings: LoadedSettings = loadSettings(cwd),
): Record<string, unknown> {
  const channels = (
    settings.merged as unknown as { channels?: Record<string, unknown> }
  ).channels;
  return channels || {};
}

export function resolveExtensionChannelEntrySpecifier(
  extensionPath: string,
  entry: string,
): string {
  return pathToFileURL(path.join(extensionPath, entry)).href;
}

/**
 * Load channel plugins from active extensions.
 * Extensions declare channels in their qwen-extension.json manifest.
 */
export async function loadChannelsFromExtensions(): Promise<number> {
  let loaded = 0;
  try {
    const extensionManager = await getExtensionManager();
    const extensions = extensionManager
      .getLoadedExtensions()
      .filter((e) => e.isActive && e.channels);

    for (const ext of extensions) {
      for (const [channelType, channelDef] of Object.entries(ext.channels!)) {
        if (await getPlugin(channelType)) {
          writeStderrLine(
            `[Extensions] Skipping channel "${channelType}" from "${ext.name}": type already registered`,
          );
          continue;
        }

        const entrySpecifier = resolveExtensionChannelEntrySpecifier(
          ext.path,
          channelDef.entry,
        );
        try {
          const module = (await import(entrySpecifier)) as {
            plugin?: ChannelPlugin;
          };
          const plugin = module.plugin;

          if (!plugin || typeof plugin.createChannel !== 'function') {
            writeStderrLine(
              `[Extensions] "${ext.name}": channel entry point does not export a valid plugin object`,
            );
            continue;
          }

          if (plugin.channelType !== channelType) {
            writeStderrLine(
              `[Extensions] "${ext.name}": channelType mismatch — manifest says "${channelType}", plugin says "${plugin.channelType}"`,
            );
            continue;
          }

          registerPlugin(plugin);
          loaded++;
          writeStdoutLine(
            `[Extensions] Loaded channel "${channelType}" from "${ext.name}"`,
          );
        } catch (err) {
          writeStderrLine(
            `[Extensions] Failed to load channel "${channelType}" from "${ext.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    writeStderrLine(
      `[Extensions] Failed to load extensions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return loaded;
}

export async function createChannel(
  name: string,
  config: ParsedChannelConfig,
  bridge: ChannelAgentBridge,
  options?: { router?: SessionRouter; proxy?: string },
): Promise<ChannelBase> {
  const channelPlugin = await getPlugin(config.type);
  if (!channelPlugin) {
    throw new Error(`Unknown channel type: "${config.type}".`);
  }
  return channelPlugin.createChannel(name, config, bridge, options);
}

export function registerToolCallDispatch(
  bridge: ChannelAgentBridge,
  router: SessionRouter,
  channels: Map<string, ChannelBase>,
): void {
  bridge.on('toolCall', (event: ToolCallEvent) => {
    const target = router.getTarget(event.sessionId);
    if (target) {
      const channel = channels.get(target.channelName);
      if (channel) {
        channel.onToolCall(target.chatId, event);
      }
    }
  });
}

export function registerSessionCleanup(
  bridge: ChannelAgentBridge,
  router: SessionRouter,
  channels: Map<string, ChannelBase>,
): void {
  bridge.on('sessionDied', (event: { sessionId: string; reason?: string }) => {
    const safeId = sanitizeLogText(event.sessionId, 128);
    const safeReason = event.reason ? sanitizeLogText(event.reason, 512) : '';
    writeStderrLine(
      `[Channel] Session ${safeId} died${safeReason ? ` (${safeReason})` : ''}, removing routing state`,
    );
    const target = router.getTarget(event.sessionId);
    const channel = target ? channels.get(target.channelName) : undefined;
    if (channel) {
      channel.onSessionDied(event.sessionId);
    } else {
      router.removeSessionId(event.sessionId);
    }
  });
}

export async function parseConfiguredChannels(
  channelsConfig: Record<string, unknown>,
  selectedNames: string[],
  opts: { defaultCwd?: string } = {},
): Promise<ParsedChannel[]> {
  const parsed: ParsedChannel[] = [];
  for (const name of selectedNames) {
    try {
      parsed.push({
        name,
        config: await parseChannelConfig(
          name,
          channelsConfig[name] as Record<string, unknown>,
          opts.defaultCwd,
        ),
      });
    } catch (err) {
      throw new Error(
        `Error in channel "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return parsed;
}
