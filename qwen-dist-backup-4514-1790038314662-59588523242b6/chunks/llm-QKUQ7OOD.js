// Force strict mode and setup for ESM
"use strict";
import {
  startEarlyStartupPrefetches
} from "./chunk-5YMXAOAB.js";
import {
  registerMcpHotReload,
  registerModelProvidersHotReload
} from "./chunk-RP2XPXQF.js";
import {
  ExtensionRefreshState,
  appEvents,
  buildDisabledSkillNamesProvider,
  buildEnabledSkillNamesProvider,
  isDebugMode,
  loadCliConfig,
  parseArguments,
  validateAuthMethod
} from "./chunk-PL2V2PQ2.js";
import {
  start_sandbox
} from "./chunk-HFXBHH4R.js";
import "./chunk-XR6I4POY.js";
import {
  getHeadlessYoloSafetyWarning
} from "./chunk-6H67XLET.js";
import {
  isAcpStartupProfilerEnabled,
  markAcpStartup,
  recordAcpConfigStartupEvent
} from "./chunk-DRD6VBNH.js";
import "./chunk-GNW23TIY.js";
import "./chunk-6OHXRCXH.js";
import {
  loadSandboxConfig
} from "./chunk-CYFQLCCG.js";
import {
  CUSTOM_SANDBOX_IMAGE_ENV_VAR,
  HOST_UPDATE_RELAUNCH_ENV_VAR,
  RELAUNCH_EXIT_CODE,
  UPDATE_COMPLETE_EXIT_CODE,
  UPDATE_ON_EXIT_MESSAGE,
  UPDATE_RELAUNCH_EXIT_CODE
} from "./chunk-A4L3TDKL.js";
import "./chunk-24FVUD5P.js";
import "./chunk-ZJ7KIWG5.js";
import {
  sanitizeTerminalText
} from "./chunk-47ECGEJC.js";
import "./chunk-2MIN6GRR.js";
import "./chunk-QHTIBUWB.js";
import "./chunk-TXASDT2M.js";
import "./chunk-4VQBQLIZ.js";
import "./chunk-PB7JBAHF.js";
import "./chunk-DMEUXLSS.js";
import {
  isValidSessionId
} from "./chunk-ZEZKIS2K.js";
import "./chunk-UIWUFHRJ.js";
import "./chunk-PXA6DGTN.js";
import "./chunk-PRMLXEQQ.js";
import "./chunk-KWYTSSTJ.js";
import "./chunk-WCCLLK7X.js";
import "./chunk-LYD3T3H7.js";
import "./chunk-WL5NKCV3.js";
import "./chunk-Y3Q5OK4D.js";
import "./chunk-3HZG3X2J.js";
import "./chunk-J6B373DZ.js";
import "./chunk-57OAHC2Y.js";
import "./chunk-2AU6C4PD.js";
import "./chunk-6GGSIMJR.js";
import "./chunk-LFKXIOGC.js";
import "./chunk-V6WHFGST.js";
import "./chunk-RN6A53UJ.js";
import "./chunk-SU64336V.js";
import "./chunk-ESBYWATJ.js";
import "./chunk-V7HT4IYM.js";
import {
  getInstallationInfo
} from "./chunk-4JFRCIMW.js";
import "./chunk-6PLDPT2C.js";
import "./chunk-FYJ7W2PI.js";
import "./chunk-STUJ7IMZ.js";
import "./chunk-L3SNMEDW.js";
import "./chunk-GDWE23OR.js";
import "./chunk-GYTKQYDB.js";
import "./chunk-RKFGE7JH.js";
import "./chunk-UDG5EZJI.js";
import "./chunk-M5GB774H.js";
import {
  EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV
} from "./chunk-3VUENPWF.js";
import "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import "./chunk-CJ3DHN5I.js";
import {
  createMinimalSettings,
  getFlattenedSchema,
  getSettingsWarnings,
  initializeLlmOutputLanguage,
  loadSettings
} from "./chunk-DRYBBTI5.js";
import "./chunk-EP6WO7OX.js";
import "./chunk-RKUWKYED.js";
import "./chunk-BW4333PP.js";
import "./chunk-IDS7MSUP.js";
import {
  initializeI18n,
  resolveLanguageSetting
} from "./chunk-POMFSBEC.js";
import "./chunk-5EJZE3FP.js";
import {
  preResolveHomeEnvOverrides
} from "./chunk-DJJJPHS3.js";
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  QWEN_CODE_SERVE_ENV,
  scrubAndReportInheritedLoaderEnv
} from "./chunk-4VYTH6OF.js";
import "./chunk-XFSFZCM5.js";
import "./chunk-2EAZ43JQ.js";
import "./chunk-NF5J2WFA.js";
import "./chunk-GY7FOHQP.js";
import "./chunk-W3N5XAZ6.js";
import "./chunk-36RKQ7ZS.js";
import "./chunk-NPQ5ZKRP.js";
import "./chunk-MR3PXB6E.js";
import "./chunk-47GVX3K4.js";
import "./chunk-GELRJXE2.js";
import {
  PRIVATE_CONVERSATIONS_RUNTIME_ENABLE,
  PRIVATE_CONVERSATIONS_RUNTIME_ENV
} from "./chunk-32CM56LO.js";
import "./chunk-MC2RYJMU.js";
import "./chunk-LJZSMWOH.js";
import "./chunk-DJLCK66M.js";
import {
  isSessionRuntimeActive,
  readWorktreeSession,
  writeWorktreeSession
} from "./chunk-M5YIHMXP.js";
import "./chunk-7MEBNX4M.js";
import "./chunk-PWRMILYW.js";
import "./chunk-LAE6RY3L.js";
import "./chunk-FHWIBVQQ.js";
import "./chunk-FXPP7VLM.js";
import "./chunk-7PQ65Z5F.js";
import "./chunk-ZPJWUGCS.js";
import "./chunk-O4A2B6V2.js";
import "./chunk-CAAUC2LP.js";
import "./chunk-SQRZJD25.js";
import "./chunk-NCXNBDGJ.js";
import "./chunk-DJYHML3Y.js";
import "./chunk-HQI463JG.js";
import "./chunk-V2XJJTAB.js";
import "./chunk-DB5RX7EU.js";
import "./chunk-UXEI7POA.js";
import "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import "./chunk-PU756QJZ.js";
import "./chunk-RSFNJ6UU.js";
import "./chunk-JYGESWZM.js";
import "./chunk-TFDCK56Y.js";
import "./chunk-FTKXJMQV.js";
import "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import {
  SessionService,
  computeInitialTurnFromHistory,
  persistSessionUsage,
  setStartupEventSink,
  watch
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import {
  closeFileWatcher,
  prepareFileWatchersForProcessExit
} from "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import {
  GitWorktreeService,
  readWorktreeSessionMarker,
  worktreeBranchForSlug,
  writeWorktreeSessionMarker
} from "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import {
  canUseRipgrep
} from "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import {
  QWEN_CODE_SIMPLE_ENV_VAR,
  isBareMode
} from "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-VNOVK4I7.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-6DB6UHY3.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import {
  logUserPrompt,
  uiTelemetryService
} from "./chunk-KKGSJZWK.js";
import {
  PRIVATE_ACP_CAPABILITY_ENV
} from "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import "./chunk-VPGRGNNH.js";
import "./chunk-ERIBG3BX.js";
import {
  Storage,
  createDebugLogger,
  isDebugLogFileEnabled,
  isDebugLoggingDegraded,
  isSubpath
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  handleUncaughtException,
  isExpectedPtyRaceError
} from "./chunk-NRQI3PGS.js";
import {
  clearInheritedPeerMessagingEnv
} from "./chunk-V5U2NZNJ.js";
import "./chunk-BSIOCNDK.js";
import {
  cleanupCheckpoints,
  registerCleanup,
  runExitCleanup
} from "./chunk-FR7RJHJR.js";
import {
  finalizeStartupProfile,
  isStartupProfilerEnabled,
  profileCheckpoint,
  recordStartupEvent,
  setInteractiveMode
} from "./chunk-QILD6R27.js";
import "./chunk-JVEGA3MM.js";
import {
  writeStderrLine,
  writeStderrLineSafe
} from "./chunk-7FA2II6K.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/llm.tsx
init_esbuild_shims();
import dns from "node:dns";
import fs6 from "node:fs";
import os from "node:os";
import path6 from "node:path";
import v8 from "node:v8";

// packages/cli/src/config/settingsWatcher.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
var debugLogger = createDebugLogger("SETTINGS_WATCHER");
function collectChangedKeys(before, after, prefix = "") {
  const changed = [];
  const keys = /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const beforeValue = before[key];
    const afterValue = after[key];
    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
      changed.push(...collectChangedKeys(beforeValue, afterValue, keyPath));
    } else if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changed.push(keyPath);
    }
  }
  return changed;
}
__name(collectChangedKeys, "collectChangedKeys");
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
function isRestartRequiredKey(changedPath) {
  const flattened = getFlattenedSchema();
  const parts = changedPath.split(".");
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join(".");
    const definition = flattened[candidate];
    if (definition) return definition.requiresRestart === true;
  }
  return false;
}
__name(isRestartRequiredKey, "isRestartRequiredKey");
var SettingsWatcher = class _SettingsWatcher {
  static {
    __name(this, "SettingsWatcher");
  }
  settings;
  watchers = /* @__PURE__ */ new Map();
  /**
   * Per-scope watch stage. `bootstrap` watches the parent directory waiting
   * for the missing `.qwen` dir to appear; `target` watches `.qwen` itself.
   */
  watchStage = /* @__PURE__ */ new Map();
  /**
   * Per-scope generation token. Bumped on every promote/demote so that a
   * stale `'all'` callback from a watcher being torn down (chokidar `close()`
   * is async) becomes a no-op instead of stacking watchers.
   */
  watchGeneration = /* @__PURE__ */ new Map();
  changeListeners = /* @__PURE__ */ new Set();
  refreshTimer = null;
  pendingScopeChanges = /* @__PURE__ */ new Set();
  processing = false;
  started = false;
  static DEBOUNCE_MS = 300;
  static LISTENER_TIMEOUT_MS = 3e4;
  constructor(settings) {
    this.settings = settings;
  }
  startWatching() {
    if (this.started) return;
    this.started = true;
    for (const { scope, settingsPath } of this.getScopePaths()) {
      if (!settingsPath) continue;
      const dir = path.dirname(settingsPath);
      if (fs.existsSync(dir)) {
        this.watchTargetDir(scope, settingsPath);
      } else {
        this.watchParentForDir(scope, settingsPath);
      }
    }
  }
  /**
   * Watches the resolved `.qwen` directory for changes to `settings.json`.
   * If `.qwen` itself is removed, demotes back to a parent bootstrap watcher
   * so a later re-creation is still caught.
   */
  watchTargetDir(scope, settingsPath) {
    const dir = path.dirname(settingsPath);
    const targetBasename = path.basename(settingsPath);
    const gen = this.bumpGeneration(scope);
    try {
      const watcher = watch(dir, {
        ignoreInitial: true,
        depth: 0,
        ignored: /* @__PURE__ */ __name((filePath, stats) => {
          if (stats && !stats.isFile() && !stats.isDirectory()) return true;
          return false;
        }, "ignored")
      }).on("all", (event, changedPath) => {
        if (this.watchGeneration.get(scope) !== gen) return;
        if (event === "unlinkDir" && changedPath === dir) {
          void this.demoteScope(scope, settingsPath);
          return;
        }
        if (path.basename(changedPath) !== targetBasename) return;
        this.scheduleRefresh(scope);
      }).on("error", (error) => {
        debugLogger.warn(`Settings watcher error for ${dir}:`, error);
      });
      this.watchers.set(scope, watcher);
      this.watchStage.set(scope, "target");
    } catch (error) {
      debugLogger.warn(
        `Failed to start settings watcher for ${scope} (${dir}):`,
        error
      );
    }
  }
  /**
   * Bootstrap watcher: monitors the parent directory (depth 0) with a strict
   * predicate that only allows the `.qwen` entry through, so unrelated
   * top-level churn is suppressed and the project tree is never recursed.
   * Promotes to a target watcher once `.qwen` appears.
   */
  watchParentForDir(scope, settingsPath) {
    const dir = path.dirname(settingsPath);
    const parentDir = path.dirname(dir);
    const dirBasename = path.basename(dir);
    const gen = this.bumpGeneration(scope);
    try {
      const watcher = watch(parentDir, {
        ignoreInitial: true,
        depth: 0,
        ignored: /* @__PURE__ */ __name((filePath) => filePath !== parentDir && path.basename(filePath) !== dirBasename, "ignored")
      }).on("all", (_event, changedPath) => {
        if (this.watchGeneration.get(scope) !== gen) return;
        if (path.basename(changedPath) !== dirBasename) return;
        void this.promoteScope(scope, settingsPath);
      }).on("error", (error) => {
        debugLogger.warn(
          `Settings bootstrap watcher error for ${parentDir}:`,
          error
        );
      });
      this.watchers.set(scope, watcher);
      this.watchStage.set(scope, "bootstrap");
    } catch (error) {
      debugLogger.warn(
        `Failed to start settings bootstrap watcher for ${scope} (${parentDir}):`,
        error
      );
      return;
    }
    if (fs.existsSync(dir)) {
      void this.promoteScope(scope, settingsPath);
    }
  }
  /** Swaps a scope's bootstrap watcher for a target watcher on `.qwen`. */
  async promoteScope(scope, settingsPath) {
    if (this.watchStage.get(scope) !== "bootstrap") return;
    await this.replaceWatcher(scope);
    if (!this.started) return;
    this.watchTargetDir(scope, settingsPath);
    this.scheduleRefresh(scope);
  }
  /** Swaps a scope's target watcher back to a parent bootstrap watcher. */
  async demoteScope(scope, settingsPath) {
    if (this.watchStage.get(scope) !== "target") return;
    await this.replaceWatcher(scope);
    if (!this.started) return;
    this.watchParentForDir(scope, settingsPath);
    this.scheduleRefresh(scope);
  }
  /**
   * Bumps the scope generation and closes its current watcher, clearing the
   * map entries before the caller opens the next watcher. Bumping first makes
   * any in-flight callback from the closing watcher a no-op.
   */
  async replaceWatcher(scope) {
    this.bumpGeneration(scope);
    const watcher = this.watchers.get(scope);
    this.watchers.delete(scope);
    this.watchStage.delete(scope);
    if (watcher) {
      try {
        await closeFileWatcher(watcher);
      } catch (err) {
        debugLogger.warn("Settings watcher close error:", err);
      }
    }
  }
  bumpGeneration(scope) {
    const next = (this.watchGeneration.get(scope) ?? 0) + 1;
    this.watchGeneration.set(scope, next);
    return next;
  }
  stopWatching() {
    if (!this.started) return;
    this.started = false;
    for (const [, watcher] of this.watchers) {
      closeFileWatcher(watcher).catch((err) => {
        debugLogger.warn("Settings watcher close error:", err);
      });
    }
    this.watchers.clear();
    this.watchStage.clear();
    for (const scope of this.watchGeneration.keys()) {
      this.bumpGeneration(scope);
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingScopeChanges.clear();
  }
  addChangeListener(listener) {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }
  getScopePaths() {
    const paths = [
      {
        scope: "User" /* User */,
        settingsPath: this.settings.user.path
      }
    ];
    if (this.settings.workspaceSettingsActive) {
      paths.push({
        scope: "Workspace" /* Workspace */,
        settingsPath: this.settings.workspace.path
      });
    }
    return paths;
  }
  scheduleRefresh(scope) {
    this.pendingScopeChanges.add(scope);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.drainPendingChanges().catch((err) => {
        debugLogger.warn("Settings watcher refresh error:", err);
      });
    }, _SettingsWatcher.DEBOUNCE_MS);
  }
  async drainPendingChanges() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pendingScopeChanges.size > 0) {
        const scopes = new Set(this.pendingScopeChanges);
        this.pendingScopeChanges.clear();
        await this.handleChange(scopes);
      }
    } finally {
      this.processing = false;
    }
  }
  async handleChange(changedScopes) {
    const events = [];
    for (const scope of changedScopes) {
      const file = this.settings.forScope(scope);
      const before = structuredClone(file.settings ?? {});
      const existedBefore = file.rawJson !== void 0;
      this.settings.reloadScopeFromDisk(scope);
      const after = file.settings ?? {};
      const existsNow = file.rawJson !== void 0;
      const changedKeys = collectChangedKeys(before, after);
      if (changedKeys.length === 0) {
        continue;
      }
      const hasHotReloadableChange = changedKeys.some(
        (key) => !isRestartRequiredKey(key)
      );
      if (!hasHotReloadableChange) {
        continue;
      }
      events.push({
        scope,
        path: file.path,
        changeType: !existedBefore && existsNow ? "created" : existedBefore && !existsNow ? "deleted" : "modified"
      });
    }
    if (events.length > 0) {
      await this.notifyListeners(events);
    }
  }
  async notifyListeners(events) {
    const TIMEOUT_MS = _SettingsWatcher.LISTENER_TIMEOUT_MS;
    const withTimeout = /* @__PURE__ */ __name((p) => {
      let timerId;
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(
          () => reject(
            new Error(
              `settings change listener timeout after ${TIMEOUT_MS}ms`
            )
          ),
          TIMEOUT_MS
        );
        if (typeof timerId === "object" && timerId !== null && "unref" in timerId) {
          timerId.unref();
        }
      });
      return Promise.race([p, timeoutPromise]).finally(() => {
        if (timerId !== void 0) clearTimeout(timerId);
      });
    }, "withTimeout");
    const results = await Promise.allSettled(
      Array.from(this.changeListeners).map(
        (listener) => withTimeout(Promise.resolve().then(() => listener(events)))
      )
    );
    for (const result of results) {
      if (result.status === "rejected") {
        debugLogger.warn("Settings change listener error:", result.reason);
      }
    }
  }
};

// packages/cli/src/config/lsp-config-watcher.ts
init_esbuild_shims();
import * as fs2 from "node:fs";
import * as path2 from "node:path";
var debugLogger2 = createDebugLogger("LSP_CONFIG_WATCHER");
var LspConfigWatcher = class _LspConfigWatcher {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.configPath = path2.join(workspaceRoot, ".lsp.json");
    this.lastSnapshot = this.readSnapshot();
  }
  static {
    __name(this, "LspConfigWatcher");
  }
  watcher;
  listener;
  refreshTimer = null;
  activeDrain;
  processing = false;
  pending = false;
  started = false;
  lastSnapshot;
  configPath;
  static DEBOUNCE_MS = 300;
  static LISTENER_TIMEOUT_MS = 3e4;
  startWatching(listener) {
    if (this.started) return;
    debugLogger2.info(`Starting LSP config watcher for ${this.configPath}`);
    try {
      const watcher = watch(this.workspaceRoot, {
        ignoreInitial: true,
        depth: 0
      }).on("all", (_event, changedPath) => {
        if (path2.basename(changedPath) !== ".lsp.json") return;
        this.scheduleRefresh();
      }).on("error", (error) => {
        debugLogger2.warn(
          `LSP config watcher error for ${this.workspaceRoot}:`,
          error
        );
      });
      this.watcher = watcher;
      this.listener = listener;
      this.started = true;
    } catch (error) {
      this.watcher = void 0;
      this.listener = void 0;
      this.started = false;
      debugLogger2.warn(
        `Failed to start LSP config watcher for ${this.workspaceRoot}:`,
        error
      );
    }
  }
  async stopWatching() {
    if (!this.started) return;
    this.started = false;
    debugLogger2.info(`Stopping LSP config watcher for ${this.configPath}`);
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pending = false;
    await this.activeDrain;
    this.listener = void 0;
    try {
      await closeFileWatcher(this.watcher);
    } catch (error) {
      debugLogger2.warn("LSP config watcher close error:", error);
    }
    this.watcher = void 0;
  }
  scheduleRefresh() {
    if (!this.started) return;
    this.pending = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.processing) return;
      const activeDrain = this.drainPendingChange().catch((error) => {
        debugLogger2.warn("LSP config watcher refresh error:", error);
      });
      this.activeDrain = activeDrain;
      void activeDrain.finally(() => {
        if (this.activeDrain === activeDrain) {
          this.activeDrain = void 0;
        }
      });
    }, _LspConfigWatcher.DEBOUNCE_MS);
    if (typeof this.refreshTimer === "object" && this.refreshTimer !== null && "unref" in this.refreshTimer) {
      this.refreshTimer.unref();
    }
  }
  /** Drains debounced changes one at a time while preserving a trailing update. */
  async drainPendingChange() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pending) {
        this.pending = false;
        await this.handleChange();
      }
    } finally {
      this.processing = false;
    }
  }
  /**
   * Compares the previous and current semantic snapshots.
   *
   * Invalid JSON emits an `invalid` event for user feedback but does not report
   * a runtime config change; the caller must keep the existing LSP state.
   */
  async handleChange() {
    const before = this.lastSnapshot;
    const after = this.readSnapshot();
    if (after.exists && after.canonical === void 0) {
      debugLogger2.warn(
        `Invalid .lsp.json; keeping existing LSP runtime state.`
      );
      const notified2 = await this.notifyListener({
        path: this.configPath,
        changeType: "invalid",
        error: after.error ?? "Invalid JSON in .lsp.json; existing LSP runtime state is unchanged."
      });
      if (notified2) {
        this.lastSnapshot = after;
      }
      return;
    }
    const changed = before.exists !== after.exists || before.canonical !== after.canonical;
    if (!changed) {
      this.lastSnapshot = after;
      return;
    }
    const event = {
      path: this.configPath,
      changeType: !before.exists && after.exists ? "created" : before.exists && !after.exists ? "deleted" : "modified"
    };
    debugLogger2.info(`LSP config changed: ${event.changeType} ${event.path}`);
    const notified = await this.notifyListener(event);
    if (notified) {
      this.lastSnapshot = after;
    }
  }
  /**
   * Reads `.lsp.json` as a single operation. ENOENT is treated as deletion so a
   * file removed during a filesystem race still reconciles servers to empty.
   */
  readSnapshot() {
    let raw;
    try {
      raw = fs2.readFileSync(this.configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { exists: false };
      }
      debugLogger2.warn("Failed to read .lsp.json:", error);
      return {
        exists: true,
        error: "Failed to read .lsp.json; existing LSP runtime state is unchanged."
      };
    }
    try {
      const parsed = JSON.parse(raw);
      return { exists: true, canonical: canonicalize(parsed) };
    } catch (error) {
      debugLogger2.warn("Failed to parse .lsp.json:", error);
      return {
        exists: true,
        error: "Invalid JSON in .lsp.json; existing LSP runtime state is unchanged."
      };
    }
  }
  /**
   * Runs the listener with timeout isolation so a hung reload cannot stall CLI.
   *
   * Returns whether the listener completed successfully; callers use this to
   * decide whether the semantic snapshot can advance or should be retried.
   */
  async notifyListener(event) {
    if (!this.listener) return true;
    const TIMEOUT_MS = _LspConfigWatcher.LISTENER_TIMEOUT_MS;
    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(
        () => reject(
          new Error(
            `LSP config change listener timeout after ${TIMEOUT_MS}ms`
          )
        ),
        TIMEOUT_MS
      );
      if (typeof timerId === "object" && timerId !== null && "unref" in timerId) {
        timerId.unref();
      }
    });
    const listenerPromise = Promise.resolve().then(
      () => this.listener?.(event)
    );
    try {
      await Promise.race([listenerPromise, timeoutPromise]);
      return true;
    } catch (error) {
      debugLogger2.warn("LSP config change listener error:", error);
      return false;
    } finally {
      if (timerId !== void 0) clearTimeout(timerId);
      void listenerPromise.catch(() => void 0);
    }
  }
};
function canonicalize(value) {
  return JSON.stringify(sortJsonValue(value));
}
__name(canonicalize, "canonicalize");
function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    const sorted = /* @__PURE__ */ Object.create(null);
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}
__name(sortJsonValue, "sortJsonValue");

// packages/cli/src/config/extension-file-watcher.ts
init_esbuild_shims();
import * as fs3 from "node:fs";
import * as path3 from "node:path";
var debugLogger3 = createDebugLogger("EXTENSION_FILE_WATCHER");
var TOP_LEVEL_FILES = /* @__PURE__ */ new Set(["extension-enablement.json"]);
var EXTENSION_FILES = /* @__PURE__ */ new Set([
  "qwen-extension.json",
  ".qwen-extension-install.json"
]);
var AUTO_REFRESH_DIRS = /* @__PURE__ */ new Set([
  "commands",
  "skills",
  "agents",
  "workflows"
]);
var STALE_DIRS = /* @__PURE__ */ new Set(["hooks"]);
var ExtensionFileWatcher = class {
  constructor(config, extensionsDir = Storage.getUserExtensionsDir(), refreshState = new ExtensionRefreshState(), storeStatePath) {
    this.config = config;
    this.extensionsDir = extensionsDir;
    this.refreshState = refreshState;
    this.storeStatePath = storeStatePath ?? path3.join(
      path3.dirname(this.extensionsDir),
      "extension-store",
      "state.json"
    );
    this.observedStoreGeneration = this.readStoreGeneration();
  }
  static {
    __name(this, "ExtensionFileWatcher");
  }
  watcher;
  bootstrapWatcher;
  mutationListenerDisposer;
  mutationSuppressionEnds = /* @__PURE__ */ new Map();
  staleFiles = /* @__PURE__ */ new Set();
  watching = false;
  watchGeneration = 0;
  storeStatePath;
  generationPoller;
  observedStoreGeneration;
  startWatching() {
    this.stopWatching();
    this.watching = true;
    const generation = ++this.watchGeneration;
    this.subscribeExtensionManagerMutations();
    this.staleFiles = this.getStaleFiles();
    const roots = this.getWatchRoots();
    if (roots.length > 0) {
      this.watcher = watch(roots, {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 50
        },
        ignored: /* @__PURE__ */ __name((filePath) => this.isIgnored(filePath), "ignored")
      }).on("all", (event, changedPath) => {
        if (generation !== this.watchGeneration) return;
        const resolvedPath = path3.resolve(changedPath);
        const action = this.getRefreshAction(
          event,
          resolvedPath
        );
        let marked = false;
        if (action === "auto") {
          marked = this.refreshState.markExtensionContentChanged(
            "extension content files changed"
          );
        } else if (action === "stale") {
          marked = this.refreshState.markExtensionsChanged(
            "extension files changed"
          );
        }
        debugLogger3.debug("Extension file event classified", {
          event,
          path: resolvedPath,
          action,
          marked
        });
      }).on("error", (error) => {
        debugLogger3.warn("Extension file watcher error:", error);
      });
    }
    if (!fs3.existsSync(this.extensionsDir)) {
      this.watchExtensionsParent();
    }
    this.startGenerationPolling();
  }
  stopWatching() {
    const watcher = this.watcher;
    const bootstrapWatcher = this.bootstrapWatcher;
    this.watcher = void 0;
    this.bootstrapWatcher = void 0;
    this.watching = false;
    this.watchGeneration++;
    if (this.generationPoller) clearInterval(this.generationPoller);
    this.generationPoller = void 0;
    this.mutationListenerDisposer?.();
    this.mutationListenerDisposer = void 0;
    this.endPendingMutationSuppressions();
    closeFileWatcher(watcher).catch((error) => {
      debugLogger3.warn("Extension file watcher close error:", error);
    });
    closeFileWatcher(bootstrapWatcher).catch((error) => {
      debugLogger3.warn("Extension bootstrap watcher close error:", error);
    });
  }
  restartWatching() {
    this.startWatching();
  }
  getWatchRoots() {
    const roots = /* @__PURE__ */ new Set();
    if (fs3.existsSync(this.extensionsDir)) {
      roots.add(this.extensionsDir);
    }
    roots.add(this.storeStatePath);
    for (const extension of this.config.getActiveExtensions()) {
      if (extension.installMetadata?.type === "link") {
        const rawSource = extension.installMetadata.source;
        const source = rawSource ? path3.resolve(rawSource) : void 0;
        if (source && fs3.existsSync(source)) {
          roots.add(source);
        }
      }
    }
    return [...roots];
  }
  getStaleFiles() {
    const files = /* @__PURE__ */ new Set();
    for (const extension of this.config.getActiveExtensions()) {
      for (const filePath of extension.contextFiles) {
        files.add(path3.resolve(filePath));
      }
      const configured = extension.config.contextFileName;
      const names = configured === void 0 ? ["QWEN.md"] : Array.isArray(configured) ? configured : [configured];
      for (const name of names) {
        files.add(path3.resolve(extension.path, name));
      }
      this.addManifestFileReference(
        files,
        extension.path,
        extension.config.hooks
      );
      this.addManifestFileReference(
        files,
        extension.path,
        extension.config.lspServers
      );
    }
    return files;
  }
  addManifestFileReference(files, extensionPath, value) {
    if (typeof value !== "string") return;
    files.add(
      path3.isAbsolute(value) ? path3.resolve(value) : path3.resolve(extensionPath, value)
    );
  }
  watchExtensionsParent() {
    this.closeBootstrapWatcher();
    const parentDir = path3.dirname(this.extensionsDir);
    const dirBasename = path3.basename(this.extensionsDir);
    const generation = this.watchGeneration;
    this.bootstrapWatcher = watch(parentDir, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      ignored: /* @__PURE__ */ __name((filePath) => filePath !== parentDir && path3.basename(filePath) !== dirBasename, "ignored")
    }).on("all", (_event, changedPath) => {
      if (generation !== this.watchGeneration) return;
      if (path3.basename(changedPath) !== dirBasename) return;
      if (!fs3.existsSync(this.extensionsDir)) return;
      this.refreshState.markExtensionsChanged("extension directory created");
      queueMicrotask(() => {
        if (this.watching) {
          this.restartWatching();
        }
      });
    }).on("error", (error) => {
      debugLogger3.warn("Extension bootstrap watcher error:", error);
    });
  }
  getRefreshAction(event, changedPath) {
    if (changedPath === path3.resolve(this.storeStatePath)) {
      const generation = this.readStoreGeneration();
      if (generation !== void 0) {
        this.markStoreGenerationChanged(generation, true);
      } else {
        this.refreshState.markExtensionsChanged(
          "extension store generation changed"
        );
      }
      return false;
    }
    if (this.staleFiles.has(changedPath)) {
      return "stale";
    }
    if (changedPath === path3.resolve(this.extensionsDir)) {
      if (event === "unlinkDir") {
        this.watchExtensionsParent();
        return "stale";
      }
      return false;
    }
    if (isSubpath(this.extensionsDir, changedPath)) {
      return this.getUserExtensionRefreshAction(event, changedPath);
    }
    return this.getLinkedExtensionRefreshAction(changedPath);
  }
  getUserExtensionRefreshAction(event, changedPath) {
    const relative2 = path3.relative(this.extensionsDir, changedPath);
    const parts = relative2.split(path3.sep).filter(Boolean);
    if (parts.length === 1) {
      if (TOP_LEVEL_FILES.has(parts[0])) return "stale";
      if (event === "addDir" || event === "unlinkDir") return "stale";
      return false;
    }
    if (!fs3.existsSync(
      path3.join(this.extensionsDir, parts[0], "qwen-extension.json")
    )) {
      return "stale";
    }
    const runtimePath = parts.slice(1);
    return this.getRuntimePathRefreshAction(runtimePath);
  }
  getLinkedExtensionRefreshAction(changedPath) {
    for (const extension of this.config.getActiveExtensions()) {
      if (extension.installMetadata?.type !== "link") continue;
      const rawSource = extension.installMetadata.source;
      const source = rawSource ? path3.resolve(rawSource) : void 0;
      if (!source || !isSubpath(source, changedPath)) continue;
      const relative2 = path3.relative(source, changedPath);
      const parts = relative2.split(path3.sep).filter(Boolean);
      return parts.length === 0 ? "stale" : this.getRuntimePathRefreshAction(parts);
    }
    return false;
  }
  getRuntimePathRefreshAction(parts) {
    if (EXTENSION_FILES.has(parts[0]) || STALE_DIRS.has(parts[0])) {
      return "stale";
    }
    if (AUTO_REFRESH_DIRS.has(parts[0])) {
      return "auto";
    }
    return false;
  }
  isIgnored(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    const searchablePath = `/${normalized}/`;
    if (searchablePath.includes("/node_modules/") || searchablePath.includes("/.git/")) {
      return true;
    }
    const basename4 = normalized.split("/").pop() ?? "";
    return basename4 === ".DS_Store" || basename4.endsWith("~") || basename4.endsWith(".swp") || basename4.endsWith(".tmp");
  }
  subscribeExtensionManagerMutations() {
    const manager = this.config.getExtensionManager();
    this.mutationListenerDisposer = manager.addMutationListener(
      (event) => {
        if (event.phase === "start") {
          this.mutationSuppressionEnds.set(
            event.id,
            this.refreshState.beginSuppression(
              () => this.restartAfterMutation()
            )
          );
          return;
        }
        const endSuppression = this.mutationSuppressionEnds.get(event.id);
        if (!endSuppression) {
          return;
        }
        this.mutationSuppressionEnds.delete(event.id);
        endSuppression();
      }
    );
  }
  endPendingMutationSuppressions() {
    const endSuppressions = [...this.mutationSuppressionEnds.values()];
    this.mutationSuppressionEnds.clear();
    for (const endSuppression of endSuppressions) {
      endSuppression();
    }
  }
  restartAfterMutation() {
    if (this.watching) {
      this.restartWatching();
    }
  }
  closeBootstrapWatcher() {
    const bootstrapWatcher = this.bootstrapWatcher;
    this.bootstrapWatcher = void 0;
    closeFileWatcher(bootstrapWatcher).catch((error) => {
      debugLogger3.warn("Extension bootstrap watcher close error:", error);
    });
  }
  startGenerationPolling() {
    if (this.generationPoller) clearInterval(this.generationPoller);
    this.pollStoreGeneration();
    this.generationPoller = setInterval(
      () => this.pollStoreGeneration(),
      3e4
    );
    this.generationPoller.unref?.();
  }
  pollStoreGeneration() {
    const generation = this.readStoreGeneration();
    if (generation === void 0) return;
    this.markStoreGenerationChanged(generation);
  }
  markStoreGenerationChanged(generation, force = false) {
    const previous = this.observedStoreGeneration;
    if (previous === void 0) {
      this.observedStoreGeneration = generation;
      return;
    }
    if (!force && previous === generation) return;
    if (this.refreshState.isSuppressed()) return;
    const marked = this.refreshState.markExtensionsChanged(
      "extension store generation changed"
    );
    if (marked || this.refreshState.needsExtensionRefresh()) {
      this.observedStoreGeneration = generation;
    }
  }
  readStoreGeneration() {
    try {
      const parsed = JSON.parse(
        fs3.readFileSync(this.storeStatePath, "utf8")
      );
      return typeof parsed.generation === "number" ? parsed.generation : void 0;
    } catch {
      return void 0;
    }
  }
};

// packages/cli/src/startup/worktreeStartup.ts
init_esbuild_shims();
import * as path4 from "node:path";
var debugLogger4 = createDebugLogger("WORKTREE_STARTUP");
var DETACHED_HEAD = "HEAD";
async function setupStartupWorktree(rawInput, options) {
  if (rawInput === void 0) return null;
  const trimmed = rawInput.trim();
  const launchCwd = process.cwd();
  const probe = new GitWorktreeService(launchCwd);
  const gitCheck = await probe.checkGitAvailable();
  if (!gitCheck.available) {
    return {
      ok: false,
      error: `--worktree: ${gitCheck.error ?? "git is not available on PATH."}`
    };
  }
  if (/[\\/]\.qwen[\\/]worktrees[\\/]/.test(launchCwd)) {
    return {
      ok: false,
      error: `--worktree: cannot start a new worktree from inside another worktree (cwd: ${launchCwd}). Run from the main checkout.`
    };
  }
  const rawRepoRoot = await probe.getRepoTopLevel();
  if (rawRepoRoot === null) {
    return {
      ok: false,
      error: `--worktree: ${launchCwd} is not a git repository. Run \`git init\` first or relaunch from inside one.`
    };
  }
  const repoRoot = path4.resolve(rawRepoRoot);
  const service = repoRoot === launchCwd ? probe : new GitWorktreeService(repoRoot);
  const prNumber = GitWorktreeService.parsePRReference(trimmed);
  const isPullRequest = prNumber !== null;
  let slug;
  if (prNumber !== null) {
    slug = `pr-${prNumber}`;
  } else if (trimmed.length === 0) {
    slug = GitWorktreeService.generateAutoSlug();
  } else {
    const validation = GitWorktreeService.validateUserWorktreeSlug(trimmed, {
      allowPrBackedShape: true
    });
    if (validation) {
      return { ok: false, error: `--worktree: ${validation}` };
    }
    slug = trimmed;
  }
  const [originalBranchRaw, originalHeadCommit] = await Promise.all([
    service.getCurrentBranch().catch(() => void 0),
    service.getCurrentCommitHash().catch(() => "")
  ]);
  const originalBranch = originalBranchRaw && originalBranchRaw !== DETACHED_HEAD ? originalBranchRaw : void 0;
  const expectedWorktreePath = service.getUserWorktreePath(slug);
  const expectedBranch = worktreeBranchForSlug(slug);
  let registered = null;
  try {
    registered = await service.getRegisteredWorktreeBranch(expectedWorktreePath);
  } catch {
    registered = null;
  }
  if (registered === null && !isPullRequest) {
    const reserved = GitWorktreeService.validateUserWorktreeSlug(slug);
    if (reserved) {
      return {
        ok: false,
        error: `--worktree: ${reserved} Use \`--worktree=#${slug.slice("pr-".length)}\` to create the worktree for that PR.`
      };
    }
  }
  if (registered !== null) {
    if (registered.branch !== expectedBranch) {
      return {
        ok: false,
        error: `--worktree: ${expectedWorktreePath} is already a git worktree, but its branch is ${registered.branch} (expected ${expectedBranch}). Refusing to re-attach. Resolve the conflict manually (e.g. \`git worktree remove ${expectedWorktreePath}\`).`
      };
    }
    const worktreePath2 = path4.resolve(expectedWorktreePath);
    try {
      process.chdir(worktreePath2);
    } catch (error) {
      return {
        ok: false,
        error: `--worktree: failed to chdir into ${worktreePath2} (${error instanceof Error ? error.message : String(error)}).`
      };
    }
    debugLogger4.debug(
      `setupStartupWorktree: re-attached to existing worktree at ${worktreePath2} (branch=${registered.branch})`
    );
    return {
      ok: true,
      context: {
        worktreePath: worktreePath2,
        slug,
        branch: registered.branch,
        repoRoot,
        originalBranch: originalBranch ?? DETACHED_HEAD,
        originalHeadCommit: registered.headCommit,
        isPullRequest,
        wasReattached: true
      }
    };
  }
  let pullRequestHeadSha = null;
  if (prNumber !== null) {
    const fetchRes = await service.fetchPullRequestRef(prNumber);
    if (!fetchRes.success) {
      return { ok: false, error: `--worktree: ${fetchRes.error}` };
    }
    pullRequestHeadSha = await service.resolveRef("FETCH_HEAD");
    if (pullRequestHeadSha === null) {
      return {
        ok: false,
        error: `--worktree: fetched PR #${prNumber} but FETCH_HEAD did not resolve to a commit SHA. Refusing to proceed (the worktree would otherwise branch off an unknown commit).`
      };
    }
  }
  const baseRef = isPullRequest ? pullRequestHeadSha : originalBranch;
  const result = await service.createUserWorktree(slug, baseRef, {
    symlinkDirectories: options?.symlinkDirectories,
    prBacked: isPullRequest
  });
  if (!result.success || !result.worktree) {
    return {
      ok: false,
      error: `--worktree: ${result.error ?? "failed to create worktree."}`
    };
  }
  const worktreePath = path4.resolve(result.worktree.path);
  try {
    process.chdir(worktreePath);
  } catch (error) {
    return {
      ok: false,
      error: `--worktree: created worktree at ${worktreePath} but failed to chdir into it (${error instanceof Error ? error.message : String(error)}). Run \`cd ${worktreePath}\` manually.`
    };
  }
  return {
    ok: true,
    context: {
      worktreePath,
      slug,
      branch: result.worktree.branch,
      repoRoot,
      originalBranch: originalBranch ?? DETACHED_HEAD,
      // For PR worktrees, the worktree's HEAD starts at the fetched PR
      // tip — not at the parent repo's HEAD. Use the SHA we locked in
      // post-fetch so the exit-dialog rev-list counts only the user's
      // new commits, not the entire PR history.
      originalHeadCommit: isPullRequest ? pullRequestHeadSha : originalHeadCommit,
      isPullRequest,
      wasReattached: false
    }
  };
}
__name(setupStartupWorktree, "setupStartupWorktree");
async function persistStartupWorktreeSidecar(config, context) {
  const sessionId = config.getSessionId();
  const sidecarPath = config.getSessionService().getWorktreeSessionPath(sessionId);
  let overrodeResumedWorktree = false;
  let overriddenSlug;
  let previous = null;
  try {
    previous = await readWorktreeSession(sidecarPath);
  } catch (error) {
    debugLogger4.warn(
      `persistStartupWorktreeSidecar: failed to read existing sidecar at ${sidecarPath} \u2014 treating as "no previous worktree" and proceeding: ${error}`
    );
    previous = null;
  }
  if (previous && previous.slug !== context.slug) {
    overrodeResumedWorktree = true;
    overriddenSlug = previous.slug;
  }
  let shouldWriteMarker = !context.wasReattached;
  if (context.wasReattached) {
    const owner = await readWorktreeSessionMarker(context.worktreePath);
    if (owner === null || owner === sessionId) {
      shouldWriteMarker = true;
    } else {
      const ownerActive = await isSessionRuntimeActive(owner, [
        context.repoRoot,
        context.worktreePath
      ]).catch((error) => {
        debugLogger4.warn(
          `persistStartupWorktreeSidecar: failed to check owner runtime ${owner}: ${error}`
        );
        return true;
      });
      shouldWriteMarker = !ownerActive;
    }
  }
  if (shouldWriteMarker) {
    await writeWorktreeSessionMarker(context.worktreePath, sessionId).catch(
      () => {
      }
    );
  }
  await writeWorktreeSession(sidecarPath, {
    slug: context.slug,
    worktreePath: context.worktreePath,
    worktreeBranch: context.branch,
    originalCwd: context.repoRoot,
    originalBranch: context.originalBranch,
    originalHeadCommit: context.originalHeadCommit
  });
  return { overrodeResumedWorktree, overriddenSlug, sidecarPath };
}
__name(persistStartupWorktreeSidecar, "persistStartupWorktreeSidecar");
function buildStartupWorktreeNotice(context, override) {
  const verb = context.wasReattached ? "Re-attached to worktree" : "Active worktree";
  const base = `[Startup] ${verb}: "${context.slug}" at ${context.worktreePath} (branch: ${context.branch}). Continue using this path for all file operations.`;
  if (override?.overrodeResumedWorktree && override.overriddenSlug) {
    return `${base}
Note: --worktree overrode the resumed session's previous worktree "${override.overriddenSlug}". That worktree directory was left intact; re-attach with \`qwen --worktree ${override.overriddenSlug}\` if needed.`;
  }
  return base;
}
__name(buildStartupWorktreeNotice, "buildStartupWorktreeNotice");

// packages/cli/src/utils/readStdin.ts
init_esbuild_shims();
function takeUtf8Prefix(value, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}
__name(takeUtf8Prefix, "takeUtf8Prefix");
async function readStdin() {
  const MAX_STDIN_SIZE = 8 * 1024 * 1024;
  return new Promise((resolve3, reject) => {
    let data = "";
    let totalSize = 0;
    let settled = false;
    process.stdin.setEncoding("utf8");
    const pipedInputShouldBeAvailableInMs = 500;
    let pipedInputTimerId = setTimeout(() => {
      onEnd();
    }, pipedInputShouldBeAvailableInMs);
    const onReadable = /* @__PURE__ */ __name(() => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        if (pipedInputTimerId) {
          clearTimeout(pipedInputTimerId);
          pipedInputTimerId = null;
        }
        const chunkSize = Buffer.byteLength(chunk, "utf8");
        if (totalSize + chunkSize > MAX_STDIN_SIZE) {
          const remainingSize = MAX_STDIN_SIZE - totalSize;
          const prefix = takeUtf8Prefix(chunk, remainingSize);
          data += prefix;
          totalSize += Buffer.byteLength(prefix, "utf8");
          writeStderrLine(
            `Warning: stdin input truncated to ${MAX_STDIN_SIZE} bytes.`
          );
          finish();
          process.stdin.destroy();
          return;
        }
        data += chunk;
        totalSize += chunkSize;
      }
    }, "onReadable");
    const finish = /* @__PURE__ */ __name(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve3(data);
    }, "finish");
    const onEnd = /* @__PURE__ */ __name(() => {
      finish();
    }, "onEnd");
    const onError = /* @__PURE__ */ __name((err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }, "onError");
    const cleanup = /* @__PURE__ */ __name(() => {
      if (pipedInputTimerId) {
        clearTimeout(pipedInputTimerId);
        pipedInputTimerId = null;
      }
      process.stdin.removeListener("readable", onReadable);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
    }, "cleanup");
    process.stdin.on("readable", onReadable);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
  });
}
__name(readStdin, "readStdin");

// packages/cli/src/utils/relaunch.ts
init_esbuild_shims();
import { spawn } from "node:child_process";
async function relaunchOnExitCode(runner, options) {
  while (true) {
    try {
      const exitCode = await runner();
      if (exitCode === UPDATE_RELAUNCH_EXIT_CODE && options?.onUpdateRelaunch) {
        const updatedExitCode = await options.onUpdateRelaunch(true);
        process.exit(updatedExitCode);
      }
      if (exitCode !== RELAUNCH_EXIT_CODE) {
        process.exit(exitCode);
      }
    } catch (error) {
      process.stdin.resume();
      writeStderrLine("Fatal error: Failed to relaunch the CLI process.");
      writeStderrLine(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}
__name(relaunchOnExitCode, "relaunchOnExitCode");
async function relaunchAppInChildProcess(additionalNodeArgs, additionalScriptArgs, options) {
  if (process.env["QWEN_CODE_NO_RELAUNCH"]) {
    return;
  }
  const runner = /* @__PURE__ */ __name(() => {
    let updateOnExitRequested = false;
    const script = process.argv[1];
    const scriptArgs = process.argv.slice(2);
    const nodeArgs = [
      ...process.execArgv,
      ...additionalNodeArgs,
      script,
      ...additionalScriptArgs,
      ...scriptArgs
    ];
    const newEnv = {
      ...process.env,
      ...options?.childEnv,
      QWEN_CODE_NO_RELAUNCH: "true"
    };
    if (newEnv["QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE"] === "1") {
      newEnv["ELECTRON_RUN_AS_NODE"] = "1";
    }
    process.stdin.pause();
    const child = spawn(process.execPath, nodeArgs, {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: newEnv
    });
    child.on("message", (message) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === UPDATE_ON_EXIT_MESSAGE) {
        updateOnExitRequested = true;
      }
    });
    try {
      options?.afterSpawn?.();
    } catch (err) {
      child.kill();
      throw err;
    }
    return new Promise((resolve3, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        process.stdin.resume();
        const exitCode = code ?? 1;
        if (exitCode === 0 && updateOnExitRequested && options?.onUpdateRelaunch) {
          updateOnExitRequested = false;
          void Promise.resolve(options.onUpdateRelaunch(false)).then(
            (updatedExitCode) => resolve3(updatedExitCode),
            reject
          );
          return;
        }
        resolve3(exitCode);
      });
    });
  }, "runner");
  await relaunchOnExitCode(runner, options);
}
__name(relaunchAppInChildProcess, "relaunchAppInChildProcess");

// packages/cli/src/utils/startupWarnings.ts
init_esbuild_shims();
import fs4 from "node:fs/promises";
async function getStartupWarnings() {
  const warningsFilePath = process.env["QWEN_CODE_WARNINGS_FILE"];
  if (!warningsFilePath) return [];
  try {
    await fs4.access(warningsFilePath);
    const warningsContent = await fs4.readFile(warningsFilePath, "utf-8");
    const warnings = warningsContent.split("\n").filter((line) => line.trim() !== "");
    try {
      await fs4.unlink(warningsFilePath);
    } catch {
      warnings.push("Warning: Could not delete temporary warnings file.");
    }
    return warnings;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    return [`Error checking/reading warnings file: ${getErrorMessage(err)}`];
  }
}
__name(getStartupWarnings, "getStartupWarnings");

// packages/cli/src/utils/userStartupWarnings.ts
init_esbuild_shims();
import fs5 from "node:fs/promises";
import path5 from "node:path";
var rootDirectoryCheck = {
  id: "root-directory",
  check: /* @__PURE__ */ __name(async (options) => {
    try {
      const workspaceRealPath = await fs5.realpath(options.workspaceRoot);
      const errorMessage = "Warning: You are running Qwen Code in the root directory. Your entire folder structure will be used for context. It is strongly recommended to run in a project-specific directory.";
      if (path5.dirname(workspaceRealPath) === workspaceRealPath) {
        return errorMessage;
      }
      return null;
    } catch (_err) {
      return "Could not verify the current directory due to a file system error.";
    }
  }, "check")
};
var ripgrepAvailabilityCheck = {
  id: "ripgrep-availability",
  check: /* @__PURE__ */ __name(async (options) => {
    if (!options.useRipgrep) {
      return null;
    }
    try {
      const isAvailable = await canUseRipgrep(options.useBuiltinRipgrep);
      if (!isAvailable) {
        return "Ripgrep not available: Please install ripgrep globally to enable faster file content search. Falling back to built-in grep.";
      }
      return null;
    } catch (error) {
      return `Ripgrep not available: ${error instanceof Error ? error.message : "Unknown error"}. Falling back to built-in grep.`;
    }
  }, "check")
};
var WARNING_CHECKS = [
  rootDirectoryCheck,
  ripgrepAvailabilityCheck
];
async function getUserStartupWarnings(options) {
  const results = await Promise.all(
    WARNING_CHECKS.map((check) => check.check(options))
  );
  return results.filter((msg) => msg !== null);
}
__name(getUserStartupWarnings, "getUserStartupWarnings");

// packages/cli/src/utils/warningHandler.ts
init_esbuild_shims();
var SUPPRESSED_WARNINGS = [
  /MaxListenersExceededWarning.*AbortSignal/
];
function isSuppressed(warning) {
  const text = `${warning.name}: ${warning.message}`;
  return SUPPRESSED_WARNINGS.some((re) => re.test(text));
}
__name(isSuppressed, "isSuppressed");
function isDebugMode2() {
  if (false) return true;
  const truthy = /* @__PURE__ */ __name((v) => !!v && v !== "0" && v.toLowerCase() !== "false", "truthy");
  return truthy(process.env["DEBUG"]) || truthy(process.env["QWEN_DEBUG"]);
}
__name(isDebugMode2, "isDebugMode");
var installedHandler = null;
function initializeWarningHandler() {
  if (installedHandler) return;
  const priorListeners = [...process.listeners("warning")];
  installedHandler = /* @__PURE__ */ __name((warning) => {
    if (!isDebugMode2() && isSuppressed(warning)) return;
    for (const fn of priorListeners) {
      try {
        fn(warning);
      } catch {
      }
    }
  }, "installedHandler");
  process.removeAllListeners("warning");
  process.on("warning", installedHandler);
}
__name(initializeWarningHandler, "initializeWarningHandler");

// packages/cli/src/llm.tsx
var debugLogger5 = createDebugLogger("STARTUP");
function clearCorruptionEnvVars() {
  delete process.env[ENV_CORRUPTED_PATH];
  delete process.env[ENV_WAS_RECOVERED];
}
__name(clearCorruptionEnvVars, "clearCorruptionEnvVars");
function validateDnsResolutionOrder(order) {
  const defaultValue = "ipv4first";
  if (order === void 0) {
    return defaultValue;
  }
  if (order === "ipv4first" || order === "verbatim") {
    return order;
  }
  writeStderrLine(
    `Invalid value for dnsResolutionOrder in settings: "${order}". Using default "${defaultValue}".`
  );
  return defaultValue;
}
__name(validateDnsResolutionOrder, "validateDnsResolutionOrder");
function getNodeMemoryArgs(isDebugMode3) {
  if ("bun" in process.versions) {
    return [];
  }
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024
  );
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (isDebugMode3) {
    writeStderrLine(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`
    );
  }
  if (process.env["QWEN_CODE_NO_RELAUNCH"]) {
    return [];
  }
  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (isDebugMode3) {
      writeStderrLine(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }
  return [];
}
__name(getNodeMemoryArgs, "getNodeMemoryArgs");
var uncaughtExceptionHandler;
function setupUncaughtExceptionHandler(config) {
  process.removeListener("uncaughtException", handleUncaughtException);
  if (uncaughtExceptionHandler) {
    process.removeListener("uncaughtException", uncaughtExceptionHandler);
  }
  uncaughtExceptionHandler = /* @__PURE__ */ __name((rawError) => {
    if (isExpectedPtyRaceError(rawError)) {
      return;
    }
    const error = rawError instanceof Error ? rawError : new Error(String(rawError));
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const line = `${timestamp} [ERROR] [STARTUP] [UNCAUGHT_EXCEPTION] ${error.message}
${error.stack ?? ""}
`;
    let logged = false;
    let logPath;
    try {
      logPath = Storage.getDebugLogPath(config.getSessionId());
      fs6.mkdirSync(path6.dirname(logPath), { recursive: true });
      fs6.appendFileSync(logPath, line, "utf8");
      logged = true;
    } catch {
    }
    if (process.stdout.isTTY) {
      try {
        process.stdout.write("\x1B[?1049l");
        process.stdout.write("\x1B[?25h");
      } catch {
      }
    }
    writeStderrLineSafe(
      `
Fatal: uncaught exception${logged ? " (logged to debug file)" : ""}
${sanitizeTerminalText(error.stack ?? error.message)}`
    );
    const monitorRegistry = config.getMonitorRegistry();
    const reapCount = monitorRegistry.getRunning().length;
    try {
      monitorRegistry.abortAll({ notify: false });
      try {
        if (logPath) {
          fs6.appendFileSync(
            logPath,
            `${(/* @__PURE__ */ new Date()).toISOString()} [ERROR] [STARTUP] [MONITOR_REAP] reaped=${reapCount}
`,
            "utf8"
          );
        }
      } catch {
      }
    } catch (reapError) {
      try {
        if (logPath) {
          const detail = reapError instanceof Error ? reapError.stack : String(reapError);
          fs6.appendFileSync(
            logPath,
            `${(/* @__PURE__ */ new Date()).toISOString()} [ERROR] [STARTUP] [MONITOR_REAP_FAILED] ${detail ?? ""}
`,
            "utf8"
          );
        }
      } catch {
      }
    }
    process.exit(1);
  }, "uncaughtExceptionHandler");
  process.on("uncaughtException", uncaughtExceptionHandler);
}
__name(setupUncaughtExceptionHandler, "setupUncaughtExceptionHandler");
function setupUnhandledRejectionHandler() {
  let unhandledRejectionOccurred = false;
  process.on("unhandledRejection", (reason, _promise) => {
    const errorMessage = `=========================================
This is an unexpected error. Please file a bug report using the /bug tool.
CRITICAL: Unhandled Promise Rejection!
=========================================
Reason: ${reason}${reason instanceof Error && reason.stack ? `
Stack trace:
${reason.stack}` : ""}`;
    debugLogger5.error(errorMessage);
    appEvents.emit("log-error" /* LogError */, errorMessage);
    if (!unhandledRejectionOccurred) {
      unhandledRejectionOccurred = true;
      appEvents.emit("open-debug-console" /* OpenDebugConsole */);
    }
  });
}
__name(setupUnhandledRejectionHandler, "setupUnhandledRejectionHandler");
function getSignalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGHUP") return 129;
  return 143;
}
__name(getSignalExitCode, "getSignalExitCode");
var SIGINT_EXIT_CONFIRM_WINDOW_MS = 1e3;
var SIGINT_RERAISE_IGNORE_MS = 50;
function installInteractiveSignalHandlers(wasRaw) {
  let cleanupStarted = false;
  let lastSigintAt = 0;
  const swallowSignalDuringCleanup = /* @__PURE__ */ __name(() => {
  }, "swallowSignalDuringCleanup");
  const beginExit = /* @__PURE__ */ __name((signal) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw);
    }
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    process.on("SIGINT", swallowSignalDuringCleanup);
    void runExitCleanup().catch((error) => {
      debugLogger5.error(`Error during ${signal} cleanup:`, error);
    }).finally(() => {
      process.exit(getSignalExitCode(signal));
    });
  }, "beginExit");
  const handleSigterm = /* @__PURE__ */ __name(() => {
    beginExit("SIGTERM");
  }, "handleSigterm");
  const handleSighup = /* @__PURE__ */ __name(() => {
    beginExit("SIGHUP");
  }, "handleSighup");
  const handleSigint = /* @__PURE__ */ __name(() => {
    if (cleanupStarted) {
      return;
    }
    const now = Date.now();
    const sincePrevious = now - lastSigintAt;
    if (sincePrevious <= SIGINT_RERAISE_IGNORE_MS) {
      return;
    }
    if (sincePrevious <= SIGINT_EXIT_CONFIRM_WINDOW_MS) {
      beginExit("SIGINT");
      return;
    }
    lastSigintAt = now;
    writeStderrLine("Press Ctrl+C again to exit.");
  }, "handleSigint");
  process.on("SIGTERM", handleSigterm);
  process.on("SIGINT", handleSigint);
  process.on("SIGHUP", handleSighup);
  return () => {
    process.removeListener("SIGTERM", handleSigterm);
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGHUP", handleSighup);
  };
}
__name(installInteractiveSignalHandlers, "installInteractiveSignalHandlers");
async function main() {
  profileCheckpoint("main_entry");
  clearInheritedPeerMessagingEnv();
  const acpStartupProfilerEnabled = isAcpStartupProfilerEnabled();
  const startupProfilerEnabled = isStartupProfilerEnabled();
  if (startupProfilerEnabled || acpStartupProfilerEnabled) {
    setStartupEventSink((name, attrs) => {
      if (startupProfilerEnabled) recordStartupEvent(name, attrs);
      if (acpStartupProfilerEnabled) recordAcpConfigStartupEvent(name);
    });
  }
  setupUnhandledRejectionHandler();
  initializeWarningHandler();
  const privateAcpParentCapability = process.env[PRIVATE_ACP_CAPABILITY_ENV];
  delete process.env[PRIVATE_ACP_CAPABILITY_ENV];
  const conversationsRuntimeMarkerSeen = process.env[PRIVATE_CONVERSATIONS_RUNTIME_ENV] === PRIVATE_CONVERSATIONS_RUNTIME_ENABLE;
  delete process.env[PRIVATE_CONVERSATIONS_RUNTIME_ENV];
  const privateExternalToolGuard = process.env[PRIVATE_EXTERNAL_TOOL_GUARD_ENV] === EXTERNAL_TOOL_GUARD_REQUIRED_VALUE ? EXTERNAL_TOOL_GUARD_REQUIRED_VALUE : void 0;
  delete process.env[PRIVATE_EXTERNAL_TOOL_GUARD_ENV];
  const privateExternalToolGuardProvider = process.env[PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV] === EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE ? EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE : void 0;
  delete process.env[PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV];
  if (process.argv.includes("--bare")) {
    process.env[QWEN_CODE_SIMPLE_ENV_VAR] = "1";
  }
  preResolveHomeEnvOverrides();
  markAcpStartup("argsParseStart");
  let argv = await parseArguments();
  delete process.env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
  markAcpStartup("argsParseEnd");
  profileCheckpoint("after_parse_arguments");
  const isAcpMode = argv.acp || argv.experimentalAcp;
  const conversationsRuntimeProvenance = isAcpMode && privateAcpParentCapability !== void 0 && conversationsRuntimeMarkerSeen;
  const privateAcpChildEnv = isAcpMode && privateAcpParentCapability !== void 0 ? {
    [PRIVATE_ACP_CAPABILITY_ENV]: privateAcpParentCapability,
    ...conversationsRuntimeProvenance ? {
      [PRIVATE_CONVERSATIONS_RUNTIME_ENV]: PRIVATE_CONVERSATIONS_RUNTIME_ENABLE
    } : {},
    ...privateExternalToolGuard ? {
      [PRIVATE_EXTERNAL_TOOL_GUARD_ENV]: privateExternalToolGuard,
      ...privateExternalToolGuardProvider ? {
        [PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV]: privateExternalToolGuardProvider
      } : {}
    } : {}
  } : void 0;
  if ((argv.acp || argv.experimentalAcp) && process.env["QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE"] === "1") {
    delete process.env["ELECTRON_RUN_AS_NODE"];
    if (process.env["QWEN_CODE_NO_RELAUNCH"] || process.env["SANDBOX"]) {
      delete process.env["QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE"];
    }
  }
  if (isBareMode(argv.bare)) {
    process.env[QWEN_CODE_SIMPLE_ENV_VAR] = "1";
  }
  markAcpStartup("settingsLoadStart");
  const settings = isBareMode(argv.bare) ? createMinimalSettings() : loadSettings();
  markAcpStartup("settingsLoadEnd");
  delete process.env[PRIVATE_CONVERSATIONS_RUNTIME_ENV];
  if (settings.corruptedPath) {
    process.env[ENV_CORRUPTED_PATH] = settings.corruptedPath;
    process.env[ENV_WAS_RECOVERED] = settings.wasRecovered ? "1" : "0";
  }
  await cleanupCheckpoints();
  profileCheckpoint("after_load_settings");
  const settingsWarnings = getSettingsWarnings(settings);
  for (const warning of settingsWarnings) {
    writeStderrLine(warning);
  }
  if (settings.corruptedPath) {
    writeStderrLine(
      "Warning: Settings file had invalid JSON and was reset. A copy of the corrupted file has been saved at: " + settings.corruptedPath
    );
  }
  if (argv.listExtensions) {
    await initializeI18n(
      resolveLanguageSetting(settings.merged.general?.language)
    );
    const { handleList: handleListExtensions } = await import("./list-5PCI4FN3.js");
    await handleListExtensions();
    process.exit(0);
  }
  if (argv.promptInteractive && !process.stdin.isTTY) {
    writeStderrLine(
      "Error: The --prompt-interactive flag cannot be used when input is piped from stdin."
    );
    process.exit(1);
  }
  const isDebugMode3 = isDebugMode(argv);
  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced?.dnsResolutionOrder)
  );
  const { themeManager, AUTO_THEME_NAME } = await import("./theme-manager-S7JZTZFB.js");
  themeManager.loadCustomThemes(settings.merged.ui?.customThemes);
  const configuredTheme = settings.merged.ui?.theme;
  if (configuredTheme && configuredTheme !== AUTO_THEME_NAME) {
    if (!themeManager.setActiveTheme(configuredTheme)) {
      writeStderrLine(`Warning: Theme "${configuredTheme}" not found.`);
    }
  } else {
    themeManager.setActiveTheme(AUTO_THEME_NAME);
  }
  if (!process.env["SANDBOX"]) {
    const memoryArgs = settings.merged.advanced?.autoConfigureMemory ? getNodeMemoryArgs(isDebugMode3) : [];
    const updateProjectRoot = process.cwd();
    const onUpdateRelaunch = /* @__PURE__ */ __name(async (relaunchOnFailure) => {
      await initializeI18n(
        resolveLanguageSetting(settings.merged.general?.language)
      );
      const { updateBeforeRelaunch } = await import("./update-relaunch-2QWLDI6K.js");
      const shouldRelaunch = await updateBeforeRelaunch(
        settings,
        updateProjectRoot,
        relaunchOnFailure
      );
      return shouldRelaunch ? UPDATE_COMPLETE_EXIT_CODE : 0;
    }, "onUpdateRelaunch");
    const sandboxConfig = await loadSandboxConfig(settings.merged, argv);
    const customSandboxImage = argv.sandboxImage ?? process.env["QWEN_SANDBOX_IMAGE"] ?? settings.merged.tools?.sandboxImage;
    const containerSandbox = sandboxConfig?.command === "docker" || sandboxConfig?.command === "podman" ? sandboxConfig : void 0;
    if (containerSandbox?.image && customSandboxImage) {
      process.env[CUSTOM_SANDBOX_IMAGE_ENV_VAR] = containerSandbox.image;
    } else if (containerSandbox) {
      const hostInstallationInfo = getInstallationInfo(updateProjectRoot, true);
      process.env[HOST_UPDATE_RELAUNCH_ENV_VAR] = String(
        Boolean(
          hostInstallationInfo.updateCommand || hostInstallationInfo.isStandalone && hostInstallationInfo.standaloneDir
        )
      );
    }
    if (sandboxConfig) {
      const partialConfig = await loadCliConfig(
        settings.merged,
        argv,
        void 0,
        [],
        // Pass separated hooks for proper source attribution
        {
          systemHooks: settings.getSystemHooks(),
          userHooks: settings.getUserHooks(),
          projectHooks: settings.getProjectHooks()
        },
        buildDisabledSkillNamesProvider(settings),
        void 0,
        void 0,
        void 0,
        void 0,
        buildEnabledSkillNamesProvider(settings)
      );
      if (!settings.merged.security?.auth?.useExternal) {
        try {
          const authType = partialConfig.getModelsConfig().getCurrentAuthType();
          if (authType) {
            const err = validateAuthMethod(authType, partialConfig);
            if (err) {
              throw new Error(err);
            }
            await partialConfig.refreshAuth(authType);
          }
        } catch (err) {
          writeStderrLine(`Error authenticating: ${err}`);
          process.exit(1);
        }
      }
      const inputFormat = argv.inputFormat;
      const isAcpMode2 = argv.acp || argv.experimentalAcp;
      let stdinData = "";
      if (!process.stdin.isTTY && inputFormat !== "stream-json" && !isAcpMode2) {
        stdinData = await readStdin();
      }
      const injectStdinIntoArgs = /* @__PURE__ */ __name((args, stdinData2) => {
        const finalArgs = [...args];
        if (stdinData2) {
          const promptIndex = finalArgs.findIndex(
            (arg) => arg === "--prompt" || arg === "-p"
          );
          if (promptIndex > -1 && finalArgs.length > promptIndex + 1) {
            finalArgs[promptIndex + 1] = `${stdinData2}

${finalArgs[promptIndex + 1]}`;
          } else {
            finalArgs.push("--prompt", stdinData2);
          }
        }
        return finalArgs;
      }, "injectStdinIntoArgs");
      const injectSandboxSessionIdIntoArgs = /* @__PURE__ */ __name((args, sessionId2) => {
        const separatorIndex = args.indexOf("--");
        const cliArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
        const hasArg = /* @__PURE__ */ __name((names) => cliArgs.some(
          (arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`))
        ), "hasArg");
        if (hasArg(["--session-id", "--sandbox-session-id"]) || hasArg(["--continue", "-c"]) || hasArg(["--resume", "-r"])) {
          return args;
        }
        const sessionArgs = ["--sandbox-session-id", sessionId2];
        if (separatorIndex < 0) {
          return [...args, ...sessionArgs];
        }
        return [...cliArgs, ...sessionArgs, ...args.slice(separatorIndex)];
      }, "injectSandboxSessionIdIntoArgs");
      const sessionId = partialConfig.getSessionId();
      const sandboxArgs = sessionId ? injectSandboxSessionIdIntoArgs(
        injectStdinIntoArgs(process.argv, stdinData),
        sessionId
      ) : injectStdinIntoArgs(process.argv, stdinData);
      delete process.env[PRIVATE_CONVERSATIONS_RUNTIME_ENV];
      await relaunchOnExitCode(
        () => start_sandbox(
          sandboxConfig,
          memoryArgs,
          partialConfig,
          sandboxArgs,
          privateAcpChildEnv
        ),
        {
          onUpdateRelaunch
        }
      );
      process.exit(0);
    } else {
      await relaunchAppInChildProcess(memoryArgs, [], {
        afterSpawn: clearCorruptionEnvVars,
        childEnv: privateAcpChildEnv,
        onUpdateRelaunch
      });
    }
  }
  if (isAcpMode && process.env[QWEN_CODE_SERVE_ENV] === "1") {
    scrubAndReportInheritedLoaderEnv(process.env, "qwen", "ACP child");
  }
  if (argv.worktree !== void 0) {
    const launchCwdForPaths = process.cwd();
    const looksLikeInlineJson = /* @__PURE__ */ __name((v) => {
      const t = v.trim();
      return t.startsWith("{") || t.startsWith("[");
    }, "looksLikeInlineJson");
    const resolveIfPath = /* @__PURE__ */ __name((v) => {
      if (typeof v !== "string" || v.length === 0) return v;
      if (looksLikeInlineJson(v)) return v;
      return path6.resolve(launchCwdForPaths, v);
    }, "resolveIfPath");
    argv.mcpConfig = resolveIfPath(argv.mcpConfig);
    argv.openaiLoggingDir = resolveIfPath(argv.openaiLoggingDir);
    argv.jsonFile = resolveIfPath(argv.jsonFile);
    argv.inputFile = resolveIfPath(argv.inputFile);
    argv.telemetryOutfile = resolveIfPath(argv.telemetryOutfile);
    if (Array.isArray(argv.includeDirectories)) {
      argv.includeDirectories = argv.includeDirectories.map(
        (d) => typeof d === "string" && d.length > 0 ? path6.resolve(launchCwdForPaths, d) : d
      );
    }
    if (typeof argv.jsonSchema === "string") {
      const trimmedSchema = argv.jsonSchema.trim();
      if (trimmedSchema.startsWith("@")) {
        const rel = trimmedSchema.slice(1);
        if (rel.length > 0 && !path6.isAbsolute(rel)) {
          argv.jsonSchema = "@" + path6.resolve(launchCwdForPaths, rel);
        }
      }
    }
  }
  let startupWorktreeContext = null;
  if (argv.worktree !== void 0 && (argv.acp || argv.experimentalAcp)) {
    writeStderrLine(
      "--worktree cannot be combined with --acp / --experimental-acp. Pass the worktree path as the cwd of the ACP loadSession / newSession request instead."
    );
    process.exit(1);
  }
  {
    const startupRes = await setupStartupWorktree(argv.worktree, {
      symlinkDirectories: settings.merged.worktree?.symlinkDirectories
    });
    if (startupRes !== null) {
      if (!startupRes.ok) {
        writeStderrLine(startupRes.error);
        process.exit(1);
      }
      startupWorktreeContext = startupRes.context;
    }
  }
  if (argv.resume !== void 0) {
    Storage.setRuntimeBaseDir(
      settings.merged.advanced?.runtimeOutputDir,
      process.cwd()
    );
    let resolvedSessionId;
    if (argv.resume === "") {
      const { showResumeSessionPicker } = await import("./StandaloneSessionPicker-FVOLVBCP.js");
      resolvedSessionId = await showResumeSessionPicker();
    } else if (!isValidSessionId(argv.resume)) {
      const sessionService = new SessionService(process.cwd());
      const matches = await sessionService.findSessionsByTitle(argv.resume);
      if (matches.length === 1) {
        resolvedSessionId = matches[0].sessionId;
      } else if (matches.length > 1) {
        writeStderrLine(
          `Multiple sessions found with title "${argv.resume}". Please select one:`
        );
        const { showResumeSessionPicker } = await import("./StandaloneSessionPicker-FVOLVBCP.js");
        resolvedSessionId = await showResumeSessionPicker(
          process.cwd(),
          matches
        );
      }
    }
    if (resolvedSessionId !== void 0) {
      argv = { ...argv, resume: resolvedSessionId };
    } else if (argv.resume === "" || !isValidSessionId(argv.resume)) {
      if (argv.resume !== "") {
        writeStderrLine(`No saved session found with title "${argv.resume}".`);
        process.exit(1);
      } else {
        process.exit(0);
      }
    }
  }
  profileCheckpoint("after_sandbox_check");
  if (!isBareMode(argv.bare)) {
    initializeLlmOutputLanguage(settings.merged.general?.outputLanguage);
  }
  {
    const settingsWatcher = isBareMode(argv.bare) ? void 0 : new SettingsWatcher(settings);
    settingsWatcher?.startWatching();
    markAcpStartup("configConstructionStart");
    const config = await loadCliConfig(
      settings.merged,
      argv.acp || argv.experimentalAcp ? { ...argv, chatRecording: false } : argv,
      process.cwd(),
      argv.extensions,
      // Pass separated hooks for proper source attribution
      {
        systemHooks: settings.getSystemHooks(),
        userHooks: settings.getUserHooks(),
        projectHooks: settings.getProjectHooks()
      },
      buildDisabledSkillNamesProvider(settings),
      void 0,
      settingsWatcher,
      void 0,
      void 0,
      buildEnabledSkillNamesProvider(settings)
    );
    markAcpStartup("configConstructionEnd");
    profileCheckpoint("after_load_cli_config");
    const nonInteractiveHousekeeping = !config.isInteractive() || config.getExperimentalZedIntegration() ? await import("./scheduler-NLRTUHGC.js") : void 0;
    if (nonInteractiveHousekeeping) {
      registerCleanup(
        () => nonInteractiveHousekeeping.stopNonInteractiveOpenAILogHousekeeping()
      );
    }
    if (settingsWatcher) {
      const disposeMcpHotReload = registerMcpHotReload(
        settingsWatcher,
        settings,
        config,
        config.getTopTierMcpServers()
      );
      registerCleanup(disposeMcpHotReload);
      const disposeModelProvidersHotReload = registerModelProvidersHotReload(
        settingsWatcher,
        settings,
        config
      );
      registerCleanup(disposeModelProvidersHotReload);
    }
    registerLspHotReload(config, registerCleanup);
    const extensionRefreshState = new ExtensionRefreshState();
    const extensionFileWatcher = isBareMode(argv.bare) || config.isSafeMode() ? void 0 : new ExtensionFileWatcher(config, void 0, extensionRefreshState);
    extensionFileWatcher?.startWatching();
    if (extensionFileWatcher) {
      const restartExtensionWatcher = /* @__PURE__ */ __name(() => extensionFileWatcher.restartWatching(), "restartExtensionWatcher");
      extensionRefreshState.on(
        "extensions-reloaded" /* ExtensionsReloaded */,
        restartExtensionWatcher
      );
      registerCleanup(() => {
        extensionRefreshState.off(
          "extensions-reloaded" /* ExtensionsReloaded */,
          restartExtensionWatcher
        );
        extensionFileWatcher.stopWatching();
      });
    }
    if (startupWorktreeContext) {
      config.setPendingStartupWorktreeNotice(
        buildStartupWorktreeNotice(startupWorktreeContext)
      );
      try {
        const startupWorktreePersist = await persistStartupWorktreeSidecar(
          config,
          startupWorktreeContext
        );
        if (startupWorktreePersist.overrodeResumedWorktree) {
          writeStderrLine(
            `--worktree overrode the resumed session's previous worktree "${startupWorktreePersist.overriddenSlug ?? "(unknown)"}". That worktree directory was left intact on disk.`
          );
        }
        config.setPendingStartupWorktreeNotice(
          buildStartupWorktreeNotice(
            startupWorktreeContext,
            startupWorktreePersist
          )
        );
      } catch (error) {
        debugLogger5.warn(
          `--worktree sidecar persist failed (non-fatal, notice preserved): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    registerCleanup(() => {
      try {
        const metrics = uiTelemetryService.getMetrics();
        const hasActivity = Object.values(metrics.models).some(
          (m) => m.api.totalRequests > 0
        );
        if (!hasActivity) return;
        persistSessionUsage({
          sessionId: config.getSessionId(),
          startTime: uiTelemetryService.getSessionStartTime(),
          endTime: /* @__PURE__ */ new Date(),
          project: config.getProjectRoot(),
          metrics
        });
      } catch {
      }
    });
    registerCleanup(() => config.shutdown());
    setupUncaughtExceptionHandler(config);
    startEarlyStartupPrefetches(config);
    const wasRaw = process.stdin.isRaw;
    let kittyProtocolDetectionComplete;
    let themeAutoDetectionComplete;
    if (config.isInteractive()) {
      registerCleanup(installInteractiveSignalHandlers(wasRaw));
    }
    if (config.isInteractive() && !wasRaw && process.stdin.isTTY) {
      const { startEarlyInputCapture, stopAndGetCapturedInput } = await import("./earlyInputCapture-UJ3KFVZQ.js");
      const { detectAndEnableKittyProtocol } = await import("./kittyProtocolDetector-BFLAKYXH.js");
      process.stdin.setRawMode(true);
      startEarlyInputCapture();
      registerCleanup(() => stopAndGetCapturedInput());
      kittyProtocolDetectionComplete = detectAndEnableKittyProtocol();
      if (!configuredTheme || configuredTheme === AUTO_THEME_NAME) {
        themeAutoDetectionComplete = themeManager.resolveAutoThemeAsync().catch((err) => {
          debugLogger5.warn("Async theme auto-detection failed:", err);
        });
      }
    }
    if (config.isInteractive()) {
      const { setMaxSizedBoxDebugging } = await import("./MaxSizedBox-LK6KCTD3.js");
      setMaxSizedBoxDebugging(isDebugMode3);
    }
    const inputFormat = process.stdin.isTTY ? "text" /* TEXT */ : typeof config.getInputFormat === "function" ? config.getInputFormat() : "text" /* TEXT */;
    const { initializeApp } = await import("./initializer-NLQKAA36.js");
    let input = config.getQuestion();
    const hasRemoteInput = Boolean(config.getInputFile?.());
    const deferIdeConnection = config.isInteractive() && !config.getExperimentalZedIntegration() && !input && !hasRemoteInput;
    markAcpStartup("appInitializationStart");
    const initializationResult = await initializeApp(config, settings, {
      deferIdeConnection
    });
    markAcpStartup("appInitializationEnd");
    profileCheckpoint("after_initialize_app");
    if (config.getExperimentalZedIntegration()) {
      markAcpStartup("acpImportStart");
      const { runAcpAgent } = await import("./acpAgent-3BYN4C6F.js");
      markAcpStartup("acpImportEnd");
      try {
        await runAcpAgent(config, settings, argv, {
          privateParentCapability: isAcpMode ? privateAcpParentCapability : void 0,
          conversationsRuntimeProvenance,
          externalToolGuardRequired: isAcpMode && privateAcpParentCapability !== void 0 && privateExternalToolGuard === EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
          externalToolGuardProviderAttached: isAcpMode && privateAcpParentCapability !== void 0 && privateExternalToolGuardProvider === EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE
        });
      } finally {
        prepareFileWatchersForProcessExit();
        await runExitCleanup();
      }
      process.exit(0);
    }
    const startupWarnings = [
      .../* @__PURE__ */ new Set([
        ...config.isSafeMode() ? [
          "\u26A0 SAFE MODE \u2014 all customizations disabled (hooks, extensions, skills, MCP servers, QWEN.md). Restart without --safe-mode to resume normal operation."
        ] : [],
        ...await getStartupWarnings(),
        ...await getUserStartupWarnings({
          workspaceRoot: process.cwd(),
          useRipgrep: settings.merged.tools?.useRipgrep ?? true,
          useBuiltinRipgrep: settings.merged.tools?.useBuiltinRipgrep ?? true
        }),
        ...getSettingsWarnings(settings),
        ...config.getWarnings(),
        ...config.getModelsConfig().getCurrentAuthType() === "qwen-oauth" /* QWEN_OAUTH */ ? [
          "Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan or another provider."
        ] : []
      ])
    ];
    const emittedStartupWarnings = new Set(startupWarnings);
    for (const warning of startupWarnings) {
      writeStderrLine(warning);
    }
    profileCheckpoint("before_render");
    if (config.isInteractive()) {
      if (config.getJsonSchema?.()) {
        writeStderrLine(
          "Error: --json-schema is a headless-only flag. Provide a one-shot prompt via -p / --prompt or pipe one in via stdin."
        );
        await runExitCleanup();
        process.exit(1);
      }
      setInteractiveMode(true);
      await kittyProtocolDetectionComplete;
      await themeAutoDetectionComplete;
      const { selectTuiRenderer, TUI_RENDERER_STRICT_ENV_VAR } = await import("./renderer-selection-M4UN63VJ.js");
      const selection = selectTuiRenderer();
      if (selection.renderer === "opentui") {
        try {
          const { startOpenTuiUI } = await import("./start-opentui-ui-2TIUB64R.js");
          const started = await startOpenTuiUI(
            config,
            settings,
            startupWarnings,
            process.cwd(),
            initializationResult,
            {
              postRenderConnectIde: deferIdeConnection,
              extensionRefreshState
            }
          );
          if (started) {
            clearCorruptionEnvVars();
            return;
          }
          if (selection.strict) {
            throw new Error(
              `OpenTUI failed to start and ${TUI_RENDERER_STRICT_ENV_VAR} forbids the ink fallback`
            );
          }
        } catch (err) {
          if (selection.strict) {
            throw err;
          }
          debugLogger5.error("OpenTUI boot failed; falling back to ink:", err);
          writeStderrLine(
            `Warning: OpenTUI failed to start \u2014 ${err instanceof Error ? err.message : String(err)} (falling back to ink)`
          );
        }
      } else {
        debugLogger5.debug(`TUI renderer: ${selection.reason}`);
      }
      const { startInteractiveUI } = await import("./startInteractiveUI-FE3IQJYZ.js");
      await startInteractiveUI(
        config,
        settings,
        startupWarnings,
        process.cwd(),
        initializationResult,
        {
          postRenderConnectIde: deferIdeConnection,
          extensionRefreshState
        }
      );
      clearCorruptionEnvVars();
      return;
    }
    clearCorruptionEnvVars();
    if (config.getDebugMode()) {
      writeStderrLine("Debug mode enabled");
      if (isDebugLogFileEnabled()) {
        writeStderrLine(
          `Logging to: ${Storage.getDebugLogPath(config.getSessionId())}`
        );
      } else {
        writeStderrLine("Debug log file disabled by QWEN_DEBUG_LOG_FILE");
      }
      if (isDebugLoggingDegraded()) {
        writeStderrLine(
          "Warning: Debug logging is degraded (write failures occurred)"
        );
      }
    }
    if (!config.isInteractive()) {
      const yoloWarning = getHeadlessYoloSafetyWarning(config);
      if (yoloWarning) writeStderrLine(yoloWarning);
    }
    if (inputFormat !== "stream-json" /* STREAM_JSON */) {
      profileCheckpoint("config_initialize_start");
      await config.initialize();
      for (const warning of config.getWarnings()) {
        if (emittedStartupWarnings.has(warning)) continue;
        emittedStartupWarnings.add(warning);
        writeStderrLine(warning);
      }
      profileCheckpoint("config_initialize_end");
      await config.waitForMcpReady();
      const failedMcpServers = typeof config.getFailedMcpServerNames === "function" ? config.getFailedMcpServerNames() : [];
      if (failedMcpServers.length > 0) {
        writeStderrLine(
          `Warning: MCP server(s) failed to start: ${failedMcpServers.join(", ")}. Continuing with built-in tools and any servers that did connect. Re-run with QWEN_CODE_DEBUG=1 to see per-server reasons.`
        );
      }
      finalizeStartupProfile(config.getSessionId());
    }
    if (inputFormat !== "stream-json" /* STREAM_JSON */ && !process.stdin.isTTY) {
      const stdinData = await readStdin();
      if (stdinData) {
        input = `${stdinData}

${input}`;
      }
    }
    const { validateNonInteractiveAuth } = await import("./validateNonInterActiveAuth-L6TOS74A.js");
    const nonInteractiveConfig = await validateNonInteractiveAuth(
      settings.merged.security?.auth?.useExternal,
      config,
      settings
    );
    const prompt_id = createNonInteractivePromptId(
      config.getSessionId(),
      config.getResumedSessionData?.()?.conversation.messages
    );
    if (inputFormat === "stream-json" /* STREAM_JSON */) {
      const trimmedInput = (input ?? "").trim();
      const { runNonInteractiveStreamJson } = await import("./session-7D27S76E.js");
      nonInteractiveHousekeeping?.startNonInteractiveOpenAILogHousekeeping(
        nonInteractiveConfig,
        settings
      );
      try {
        await runNonInteractiveStreamJson(
          nonInteractiveConfig,
          trimmedInput.length > 0 ? trimmedInput : "",
          settings
        );
      } finally {
        await runExitCleanup();
      }
      process.exit(process.exitCode ?? 0);
    }
    if (!input) {
      writeStderrLine(
        `No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.`
      );
      process.exit(1);
    }
    logUserPrompt(config, {
      "event.name": "user_prompt",
      "event.timestamp": (/* @__PURE__ */ new Date()).toISOString(),
      prompt: input,
      prompt_id,
      auth_type: config.getContentGeneratorConfig()?.authType,
      prompt_length: input.length
    });
    debugLogger5.debug(`Session ID: ${config.getSessionId()}`);
    const { runNonInteractive } = await import("./nonInteractiveCli-2TR5WU4C.js");
    nonInteractiveHousekeeping?.startNonInteractiveOpenAILogHousekeeping(
      nonInteractiveConfig,
      settings
    );
    let exitCode;
    try {
      exitCode = await runNonInteractive(
        nonInteractiveConfig,
        settings,
        input,
        prompt_id
      );
    } finally {
      await runExitCleanup();
    }
    process.exit(exitCode);
  }
}
__name(main, "main");
function createNonInteractivePromptId(sessionId, resumedRecords) {
  const lastTurn = resumedRecords?.length ? computeInitialTurnFromHistory(resumedRecords, sessionId) : -1;
  return `${sessionId}########${lastTurn + 1}`;
}
__name(createNonInteractivePromptId, "createNonInteractivePromptId");
function registerLspHotReload(config, registerCleanup2) {
  const lspClient = config.getLspClient?.();
  const runtimeConfig = config;
  const reinitializeLsp = runtimeConfig.reinitializeLsp;
  if (config.isLspEnabled?.() !== true || !lspClient?.reinitialize || !reinitializeLsp) {
    return;
  }
  const lspConfigWatcher = new LspConfigWatcher(config.getProjectRoot());
  debugLogger5.info(
    `Registering LSP config hot reload watcher for ${config.getProjectRoot()}`
  );
  lspConfigWatcher.startWatching(async (event) => {
    if (event.changeType === "invalid") {
      debugLogger5.warn(`Invalid LSP config file ${event.path}: ${event.error}`);
      appEvents.emit("log-error" /* LogError */, event.error);
      return;
    }
    debugLogger5.info(
      `Reloading LSP server settings: changeType=${event.changeType}, path=${event.path}`
    );
    let errorReported = false;
    try {
      const result = await reinitializeLsp();
      if (result) {
        const failedServers = getRuntimeReloadFailedNames(result.reconcile);
        debugLogger5.info(
          `Reloaded LSP server settings: added=${formatRuntimeReloadNames(
            result.reconcile.added
          )}, removed=${formatRuntimeReloadNames(
            result.reconcile.removed
          )}, restarted=${formatRuntimeReloadNames(
            result.reconcile.restarted
          )}, unchanged=${formatRuntimeReloadNames(
            result.reconcile.unchanged
          )}, failed=${formatRuntimeReloadNames(
            failedServers
          )}, skipped=${formatRuntimeReloadNames(
            result.skipped.map((server) => server.name)
          )}`
        );
        if (failedServers.length > 0) {
          appEvents.emit("lsp-status-changed" /* LspStatusChanged */);
          const changedServers = [
            ...result.reconcile.added,
            ...result.reconcile.removed,
            ...result.reconcile.restarted
          ];
          const message = `LSP reload partially completed: changed=${formatRuntimeReloadNames(
            changedServers
          )}, failed=${formatRuntimeReloadNames(
            failedServers
          )}. Run with --debug for details.`;
          appEvents.emit("log-error" /* LogError */, message);
          errorReported = true;
          throw new Error(message);
        }
      } else {
        debugLogger5.info(
          "Skipped LSP server settings reload because LSP is disabled or no client is available"
        );
      }
      appEvents.emit("lsp-status-changed" /* LspStatusChanged */);
    } catch (error) {
      debugLogger5.warn("Failed to reload LSP server settings:", error);
      if (!errorReported) {
        const message = error instanceof Error ? `Failed to reload LSP server settings: ${error.message}. Some LSP servers may have been partially updated. Run with --debug for details.` : "Failed to reload LSP server settings; some LSP servers may have been partially updated. Run with --debug for details.";
        appEvents.emit("log-error" /* LogError */, message);
      }
      throw error;
    }
  });
  registerCleanup2(() => lspConfigWatcher.stopWatching());
}
__name(registerLspHotReload, "registerLspHotReload");
function formatRuntimeReloadNames(names) {
  return names.length === 0 ? "<none>" : names.join(",");
}
__name(formatRuntimeReloadNames, "formatRuntimeReloadNames");
function getRuntimeReloadFailedNames(reconcile) {
  return reconcile.failed ?? [];
}
__name(getRuntimeReloadFailedNames, "getRuntimeReloadFailedNames");
export {
  createNonInteractivePromptId,
  main,
  registerLspHotReload,
  setupUncaughtExceptionHandler,
  setupUnhandledRejectionHandler,
  validateDnsResolutionOrder
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
