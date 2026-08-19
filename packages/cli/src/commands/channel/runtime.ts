import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashDaemonWorkspace, Storage } from '@qwen-code/qwen-code-core';
import type {
  SessionRouter,
  ChannelAgentBridge,
  ChannelBase,
  ChannelBaseOptions,
  ChannelPlugin,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  ToolCallEvent,
} from '@qwen-code/channel-base';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { loadSettings, type LoadedSettings } from '../../config/settings.js';
import { isAllChannelSelectionName } from '../../serve/channel-selection.js';
import {
  writeStderrLine,
  writeStderrLineBestEffort,
  writeStdoutLine,
} from '../../utils/stdioHelpers.js';
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

function daemonChannelStatePath(
  workspaceCwd: string,
  fileName: string,
): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    'channels',
    'daemon',
    hashDaemonWorkspace(workspaceCwd),
    fileName,
  );
}

export function daemonSessionRoutesPath(workspaceCwd: string): string {
  return daemonChannelStatePath(workspaceCwd, 'routes.json');
}

export function daemonObservedContactsPath(workspaceCwd: string): string {
  return daemonChannelStatePath(workspaceCwd, 'observed-contacts.json');
}

export function daemonChannelLoopPath(workspaceCwd: string): string {
  return daemonChannelStatePath(workspaceCwd, 'cron.json');
}

/**
 * Daemon-managed counterpart of the standalone `channelRuntimeStatePath`
 * (channel-state-store.ts): `qwen serve` persists per-workspace channel
 * runtime state under `channels/daemon/<hash>/channel-state.json`, the
 * standalone `qwen channel` commands under `channels/standalone/<hash>`.
 * Each service owns its own file exclusively — a stop in one mode never
 * writes the other's file, so the two state trees never cross-contaminate
 * (#8975). The workspace arrives already canonicalized by the daemon
 * (canonicalizeWorkspace); unlike the standalone path helper this one
 * requires a workspace — daemon channel state is always workspace-scoped.
 */
export function daemonChannelRuntimeStatePath(workspaceCwd: string): string {
  return daemonChannelStatePath(workspaceCwd, 'channel-state.json');
}

export function daemonChannelStateDir(
  workspaceCwd: string,
  channelName: string,
): string {
  const label =
    channelName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 32) || 'channel';
  const hash = createHash('sha256')
    .update(channelName)
    .digest('hex')
    .slice(0, 16);
  return daemonChannelStatePath(
    workspaceCwd,
    path.join('instances', `${label}-${hash}`),
  );
}

export function channelLoopPath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'channels', 'cron.json');
}

// (workspace, name) pairs already warned about a reserved channel name
// this process (R11-15): `loadChannelsConfig` runs per-request on the
// deferred webhook auth path (readDeferredWebhookSecret), so without
// dedup one unresolved hand-edited entry grows stderr by an identical
// line per webhook POST, burying real diagnostics while the runtime
// stays deferred. Key on the PAIR, not the workspace: `all`, ` all` and
// `all ` are all reserved variants, and a workspace-keyed set silences
// every later variant once one warned — a user who edits settings to a
// differently-spelled reserved key then gets a silently
// never-connecting channel with nothing in the logs explaining why.
// The NUL separator cannot occur in a path or a settings key as parsed
// here, so the pair cannot collide (#8975).
const reservedNameWarnedEntries = new Set<string>();

/** Test seam (R11-15): forget the warned-entry dedup set. */
export function resetReservedNameWarningsForTesting(): void {
  reservedNameWarnedEntries.clear();
}

export function loadChannelsConfig(
  cwd: string = process.cwd(),
  settings: LoadedSettings = loadSettings(cwd),
): Record<string, unknown> {
  const channels = (
    settings.merged as unknown as { channels?: Record<string, unknown> }
  ).channels;
  if (!channels) return Object.create(null);
  // `all` is the whole-selection placeholder, reserved by the management
  // API but unenforced here: a hand-edited/legacy `channels.all` entry
  // would be connected by a mode-`all` worker, yet the stop capture's
  // placeholder filter then drops the name from the persisted stopped
  // set and the channel resurrects on the next `--channel all` (R10-36).
  // Warn and skip the entry where settings are read so the collision
  // cannot be established; the placeholder filters downstream stay as
  // defense in depth.
  //
  // ALWAYS rebuild into the null-prototype map (R11-31): channel names are
  // user-controlled settings keys, and lookup sites index this map with
  // them (`channelsConfig[name]`); an identity return of the
  // prototype-bearing settings object resolves inherited
  // Object.prototype members (`constructor`, `toString`, ...) for
  // unconfigured names, bypassing not-found guards. The rebuild also keeps
  // a channel literally named `__proto__` as an own entry instead of
  // routing through the Object.prototype setter — which would silently
  // drop the channel and set the map's prototype to its config (same
  // hazard the state store's filterChannelStates avoids).
  const filtered: Record<string, unknown> = Object.create(null);
  for (const [name, config] of Object.entries(channels)) {
    if (isAllChannelSelectionName(name)) {
      const dedupKey = `${cwd}\u0000${name}`;
      if (!reservedNameWarnedEntries.has(dedupKey)) {
        reservedNameWarnedEntries.add(dedupKey);
        // Best-effort sink: this warning fires on EVERY launch of a
        // worker whose settings keep the reserved entry, and the daemon
        // supervisor spawns a fresh process per launch — a loud write to
        // a failing stderr target raises an async 'error' event that
        // kills the process past any try/catch, turning a tolerated
        // config into a crash loop bounded only by the restart budget.
        writeStderrLineBestEffort(
          `[Channel] Warning: ignoring channel "${sanitizeLogText(name, 128)}" — the name is reserved for the whole-channel selection (#8975).`,
        );
      }
      continue;
    }
    filtered[name] = config;
  }
  return filtered;
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
  options?: ChannelBaseOptions,
): Promise<ChannelBase> {
  const channelPlugin = await getPlugin(config.type);
  if (!channelPlugin) {
    throw new Error(`Unknown channel type: "${config.type}".`);
  }
  return channelPlugin.createChannel(name, config, bridge, options);
}

export function selectFirstModel(
  parsed: ParsedChannel[],
  bridgeLabel: string,
): string | undefined {
  const models = [
    ...new Set(
      parsed
        .map((channel) => channel.config.model)
        .filter((model): model is string => Boolean(model)),
    ),
  ];
  if (models.length > 1) {
    writeStderrLine(
      `[Channel] Warning: Multiple models configured (${models.join(', ')}). ` +
        `${bridgeLabel} will use "${models[0]}".`,
    );
  }
  return models[0];
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
        channel.dispatchToolCall(event);
      }
    }
  });
}

export function registerBackgroundResponseRelay(
  bridge: ChannelAgentBridge,
  router: SessionRouter,
  channels: Map<string, ChannelBase>,
): void {
  bridge.on('backgroundResponse', (sessionId: string, text: string) => {
    const target = router.getTarget(sessionId);
    if (!target) {
      writeStderrLine(
        `[Channel] No route for background response from session ${sanitizeLogText(sessionId, 128)}`,
      );
      return;
    }
    const channel = channels.get(target.channelName);
    if (!channel) {
      writeStderrLine(
        `[Channel] No channel "${sanitizeLogText(target.channelName, 64)}" for background response from session ${sanitizeLogText(sessionId, 128)}`,
      );
      return;
    }
    void channel
      .dispatchBackgroundResponse(sessionId, text)
      .catch((err: unknown) => {
        writeStderrLine(
          `[Channel] Background response relay failed for session ${sanitizeLogText(sessionId, 128)}: ${err instanceof Error ? sanitizeLogText(err.message, 512) : sanitizeLogText(String(err), 512)}`,
        );
      });
  });
}

function cancelPermissionRequest(
  bridge: ChannelAgentBridge,
  requestId: string,
): void {
  if (!bridge.respondToPermission) {
    return;
  }
  void bridge
    .respondToPermission(requestId, { outcome: { outcome: 'cancelled' } })
    .catch((err: unknown) => {
      writeStderrLine(
        `[Channel] Permission cancellation failed for ${sanitizeLogText(requestId, 128)}: ${err instanceof Error ? sanitizeLogText(err.message, 512) : sanitizeLogText(String(err), 512)}`,
      );
    });
}

export function registerPermissionRelay(
  bridge: ChannelAgentBridge,
  router: SessionRouter,
  channels: Map<string, ChannelBase>,
): void {
  bridge.on('permissionRequest', (event: PermissionRequestEvent) => {
    const target = router.getTarget(event.sessionId);
    if (!target) {
      writeStderrLine(
        `[Channel] No route for session ${sanitizeLogText(event.sessionId, 128)}; cancelling permission ${sanitizeLogText(event.requestId, 128)}`,
      );
      cancelPermissionRequest(bridge, event.requestId);
      return;
    }
    const channel = channels.get(target.channelName);
    if (!channel) {
      writeStderrLine(
        `[Channel] No channel "${sanitizeLogText(target.channelName, 64)}" for session ${sanitizeLogText(event.sessionId, 128)}; cancelling permission ${sanitizeLogText(event.requestId, 128)}`,
      );
      cancelPermissionRequest(bridge, event.requestId);
      return;
    }
    channel.dispatchPermissionRequest(event).catch((err: unknown) => {
      writeStderrLine(
        `[Channel] Permission relay failed for ${sanitizeLogText(event.requestId, 128)}: ${err instanceof Error ? sanitizeLogText(err.message, 512) : sanitizeLogText(String(err), 512)}`,
      );
      cancelPermissionRequest(bridge, event.requestId);
    });
  });

  bridge.on('permissionResolved', (event: PermissionResolvedEvent) => {
    for (const channel of channels.values()) {
      channel.dispatchPermissionResolved(event);
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
      `[Channel] Session ${safeId} died${safeReason ? ` (${safeReason})` : ''}, updating routing state`,
    );
    const target = router.getTarget(event.sessionId);
    const channel = target ? channels.get(target.channelName) : undefined;
    if (channel) {
      channel.onSessionDied(event.sessionId);
    } else {
      router.handleSessionDied(event.sessionId);
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
    const rawConfig = channelsConfig[name];
    if (!rawConfig || typeof rawConfig !== 'object') {
      throw new Error(
        `Error in channel "${name}": channel is not configured. Add a "${name}" entry under "channels" in settings.json.`,
      );
    }
    try {
      parsed.push({
        name,
        config: await parseChannelConfig(
          name,
          rawConfig as Record<string, unknown>,
          opts.defaultCwd,
          { resolveEnvVars: 'available' },
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
