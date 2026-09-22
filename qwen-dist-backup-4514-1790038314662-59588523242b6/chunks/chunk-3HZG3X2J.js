// Force strict mode and setup for ESM
"use strict";
import {
  getExtensionManager
} from "./chunk-J6B373DZ.js";
import {
  parseChannelConfig
} from "./chunk-2AU6C4PD.js";
import {
  getPlugin,
  registerPlugin
} from "./chunk-6GGSIMJR.js";
import {
  sanitizeLogText
} from "./chunk-PZRXWQUA.js";
import {
  loadSettings
} from "./chunk-DRYBBTI5.js";
import {
  hashDaemonWorkspace
} from "./chunk-GVTAFLWB.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine,
  writeStdoutLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/channel/runtime.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
function resolveChannelLocale(value) {
  if (typeof value !== "string") return "en";
  const language = value.trim().replaceAll("_", "-").toLowerCase();
  return language === "zh" || language.startsWith("zh-") || language === "chinese" || language === "\u4E2D\u6587" ? "zh" : "en";
}
__name(resolveChannelLocale, "resolveChannelLocale");
function sessionsPath() {
  return path.join(Storage.getGlobalQwenDir(), "channels", "sessions.json");
}
__name(sessionsPath, "sessionsPath");
function daemonChannelStatePath(workspaceCwd, fileName) {
  return path.join(
    Storage.getGlobalQwenDir(),
    "channels",
    "daemon",
    hashDaemonWorkspace(workspaceCwd),
    fileName
  );
}
__name(daemonChannelStatePath, "daemonChannelStatePath");
function daemonSessionRoutesPath(workspaceCwd) {
  return daemonChannelStatePath(workspaceCwd, "routes.json");
}
__name(daemonSessionRoutesPath, "daemonSessionRoutesPath");
function daemonObservedContactsPath(workspaceCwd) {
  return daemonChannelStatePath(workspaceCwd, "observed-contacts.json");
}
__name(daemonObservedContactsPath, "daemonObservedContactsPath");
function daemonChannelLoopPath(workspaceCwd) {
  return daemonChannelStatePath(workspaceCwd, "cron.json");
}
__name(daemonChannelLoopPath, "daemonChannelLoopPath");
function daemonChannelStateDir(workspaceCwd, channelName) {
  const label = channelName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32) || "channel";
  const hash = createHash("sha256").update(channelName).digest("hex").slice(0, 16);
  return daemonChannelStatePath(
    workspaceCwd,
    path.join("instances", `${label}-${hash}`)
  );
}
__name(daemonChannelStateDir, "daemonChannelStateDir");
function channelLoopPath() {
  return path.join(Storage.getGlobalQwenDir(), "channels", "cron.json");
}
__name(channelLoopPath, "channelLoopPath");
function loadChannelsConfig(cwd = process.cwd(), settings = loadSettings(cwd)) {
  const channels = settings.merged.channels;
  return channels || {};
}
__name(loadChannelsConfig, "loadChannelsConfig");
function resolveExtensionChannelEntrySpecifier(extensionPath, entry) {
  return pathToFileURL(path.join(extensionPath, entry)).href;
}
__name(resolveExtensionChannelEntrySpecifier, "resolveExtensionChannelEntrySpecifier");
async function loadChannelsFromExtensions() {
  let loaded = 0;
  try {
    const extensionManager = await getExtensionManager();
    const extensions = extensionManager.getLoadedExtensions().filter((e) => e.isActive && e.channels);
    for (const ext of extensions) {
      for (const [channelType, channelDef] of Object.entries(ext.channels)) {
        if (await getPlugin(channelType)) {
          writeStderrLine(
            `[Extensions] Skipping channel "${channelType}" from "${ext.name}": type already registered`
          );
          continue;
        }
        const entrySpecifier = resolveExtensionChannelEntrySpecifier(
          ext.path,
          channelDef.entry
        );
        try {
          const module = await import(entrySpecifier);
          const plugin = module.plugin;
          if (!plugin || typeof plugin.createChannel !== "function") {
            writeStderrLine(
              `[Extensions] "${ext.name}": channel entry point does not export a valid plugin object`
            );
            continue;
          }
          if (plugin.channelType !== channelType) {
            writeStderrLine(
              `[Extensions] "${ext.name}": channelType mismatch \u2014 manifest says "${channelType}", plugin says "${plugin.channelType}"`
            );
            continue;
          }
          registerPlugin(plugin);
          loaded++;
          writeStdoutLine(
            `[Extensions] Loaded channel "${channelType}" from "${ext.name}"`
          );
        } catch (err) {
          writeStderrLine(
            `[Extensions] Failed to load channel "${channelType}" from "${ext.name}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  } catch (err) {
    writeStderrLine(
      `[Extensions] Failed to load extensions: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return loaded;
}
__name(loadChannelsFromExtensions, "loadChannelsFromExtensions");
async function createChannel(name, config, bridge, options) {
  const channelPlugin = await getPlugin(config.type);
  if (!channelPlugin) {
    throw new Error(`Unknown channel type: "${config.type}".`);
  }
  return channelPlugin.createChannel(name, config, bridge, options);
}
__name(createChannel, "createChannel");
function selectFirstModel(parsed, bridgeLabel) {
  const models = [
    ...new Set(
      parsed.map((channel) => channel.config.model).filter((model) => Boolean(model))
    )
  ];
  if (models.length > 1) {
    writeStderrLine(
      `[Channel] Warning: Multiple models configured (${models.join(", ")}). ${bridgeLabel} will use "${models[0]}".`
    );
  }
  return models[0];
}
__name(selectFirstModel, "selectFirstModel");
function registerToolCallDispatch(bridge, router, channels) {
  bridge.on("toolCall", (event) => {
    const target = router.getTarget(event.sessionId);
    if (target) {
      const channel = channels.get(target.channelName);
      if (channel) {
        channel.dispatchToolCall(event);
      }
    }
  });
}
__name(registerToolCallDispatch, "registerToolCallDispatch");
function registerBackgroundResponseRelay(bridge, router, channels) {
  bridge.on(
    "backgroundResponse",
    (sessionId, text, context) => {
      const target = router.getTarget(sessionId);
      if (!target) {
        writeStderrLine(
          `[Channel] No route for background response from session ${sanitizeLogText(sessionId, 128)}`
        );
        return;
      }
      const channel = channels.get(target.channelName);
      if (!channel) {
        writeStderrLine(
          `[Channel] No channel "${sanitizeLogText(target.channelName, 64)}" for background response from session ${sanitizeLogText(sessionId, 128)}`
        );
        return;
      }
      void channel.dispatchBackgroundResponse(sessionId, text, context).catch((err) => {
        writeStderrLine(
          `[Channel] Background response relay failed for session ${sanitizeLogText(sessionId, 128)}: ${err instanceof Error ? sanitizeLogText(err.message, 512) : sanitizeLogText(String(err), 512)}`
        );
      });
    }
  );
}
__name(registerBackgroundResponseRelay, "registerBackgroundResponseRelay");
function cancelPermissionRequest(bridge, requestId) {
  if (!bridge.respondToPermission) {
    return;
  }
  void bridge.respondToPermission(requestId, { outcome: { outcome: "cancelled" } }).catch((err) => {
    writeStderrLine(
      `[Channel] Permission cancellation failed for ${sanitizeLogText(requestId, 128)}: ${err instanceof Error ? sanitizeLogText(err.message, 512) : sanitizeLogText(String(err), 512)}`
    );
  });
}
__name(cancelPermissionRequest, "cancelPermissionRequest");
function registerPermissionRelay(bridge, router, channels) {
  bridge.on("permissionRequest", (event) => {
    const target = router.getTarget(event.sessionId);
    if (!target) {
      writeStderrLine(
        `[Channel] No route for session ${sanitizeLogText(event.sessionId, 128)}; cancelling permission ${sanitizeLogText(event.requestId, 128)}`
      );
      cancelPermissionRequest(bridge, event.requestId);
      return;
    }
    const channel = channels.get(target.channelName);
    if (!channel) {
      writeStderrLine(
        `[Channel] No channel "${sanitizeLogText(target.channelName, 64)}" for session ${sanitizeLogText(event.sessionId, 128)}; cancelling permission ${sanitizeLogText(event.requestId, 128)}`
      );
      cancelPermissionRequest(bridge, event.requestId);
      return;
    }
    channel.dispatchPermissionRequest(event).catch((err) => {
      writeStderrLine(
        `[Channel] Permission relay failed for ${sanitizeLogText(event.requestId, 128)}: ${err instanceof Error ? sanitizeLogText(err.message, 512) : sanitizeLogText(String(err), 512)}`
      );
      cancelPermissionRequest(bridge, event.requestId);
    });
  });
  bridge.on("permissionResolved", (event) => {
    for (const channel of channels.values()) {
      channel.dispatchPermissionResolved(event);
    }
  });
}
__name(registerPermissionRelay, "registerPermissionRelay");
function registerSessionCleanup(bridge, router, channels) {
  bridge.on("sessionDied", (event) => {
    const safeId = sanitizeLogText(event.sessionId, 128);
    const safeReason = event.reason ? sanitizeLogText(event.reason, 512) : "";
    writeStderrLine(
      `[Channel] Session ${safeId} died${safeReason ? ` (${safeReason})` : ""}, updating routing state`
    );
    const target = router.getTarget(event.sessionId);
    const channel = target ? channels.get(target.channelName) : void 0;
    if (channel) {
      channel.onSessionDied(event.sessionId);
    } else {
      router.handleSessionDied(event.sessionId);
    }
  });
}
__name(registerSessionCleanup, "registerSessionCleanup");
async function parseConfiguredChannels(channelsConfig, selectedNames, opts = {}) {
  const parsed = [];
  for (const name of selectedNames) {
    const rawConfig = channelsConfig[name];
    if (!rawConfig || typeof rawConfig !== "object") {
      throw new Error(
        `Error in channel "${name}": channel is not configured. Add a "${name}" entry under "channels" in settings.json.`
      );
    }
    try {
      parsed.push({
        name,
        config: await parseChannelConfig(
          name,
          rawConfig,
          opts.defaultCwd,
          { resolveEnvVars: "available" }
        )
      });
    } catch (err) {
      throw new Error(
        `Error in channel "${name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return parsed;
}
__name(parseConfiguredChannels, "parseConfiguredChannels");

export {
  resolveChannelLocale,
  sessionsPath,
  daemonSessionRoutesPath,
  daemonObservedContactsPath,
  daemonChannelLoopPath,
  daemonChannelStateDir,
  channelLoopPath,
  loadChannelsConfig,
  resolveExtensionChannelEntrySpecifier,
  loadChannelsFromExtensions,
  createChannel,
  selectFirstModel,
  registerToolCallDispatch,
  registerBackgroundResponseRelay,
  registerPermissionRelay,
  registerSessionCleanup,
  parseConfiguredChannels
};
