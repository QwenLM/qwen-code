/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { render, Text, useInput } from 'ink';
import type { AppContainerComponent } from './ui/AppContainerProps.js';
import { FoldStateProvider } from './ui/contexts/FoldStateContext.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import {
  registerCleanup,
  setupTtyCheck,
  gracefulExit,
} from './utils/cleanup.js';
import {
  type I18nService,
  type StartupWarning,
  type Config,
  type SessionResumeData,
  coreEvents,
  createWorkingStdio,
  disableMouseEvents,
  enableMouseEvents,
  disableLineWrapping,
  enableLineWrapping,
  shouldEnterAlternateScreen,
  writeToStdout,
  getVersion,
  rememberApproval,
  createPermissionRequestHookBridge,
  permissionPromptNotifier,
  BRAND_CLI_NAME,
  markStartupMilestone,
} from '@qwen-code/core';
import type { LoadedSettings } from './config/settings.js';
import type { SessionUiBinding } from './ui/session/prepareSessionUi.js';
import type { StartupCoordinator } from './startup/startupCoordinator.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';
import {
  detectSystemUiLocale,
  T,
  I18nServiceProvider,
} from './ui/i18n/index.js';
import { bindI18nSettings } from './ui/i18n/bindI18nSettings.js';
import { bindUiLocale } from './ui/i18n/uiLocaleState.js';
import { MouseProvider } from './ui/contexts/MouseContext.js';
import { StreamingState } from './ui/types.js';
import { computeTerminalTitle } from './utils/windowTitle.js';

import { SessionStatsProvider } from './ui/contexts/SessionContext.js';
import { VimModeProvider } from './ui/contexts/VimModeContext.js';
import { KeyMatchersProvider } from './ui/hooks/useKeyMatchers.js';
import { loadKeyMatchers } from './ui/key/keyMatchers.js';
import { KeypressProvider } from './ui/contexts/KeypressContext.js';
import { useKittyKeyboardProtocol } from './ui/hooks/useKittyKeyboardProtocol.js';
import { terminalCapabilityManager } from './ui/utils/terminalCapabilityManager.js';
import { ScrollProvider } from './ui/contexts/ScrollProvider.js';
import { TerminalProvider } from './ui/contexts/TerminalContext.js';
import { OverflowProvider } from './ui/contexts/OverflowContext.js';
import { KeyboardContextProvider } from './ui/contexts/KeyboardContextRegistry.js';
import { ActionHandlerRegistryProvider } from './ui/contexts/ActionHandlerRegistry.js';
import { AppFocusProvider } from './ui/state/AppFocusContext.js';
import { AlternateScreen } from './ink/components/AlternateScreen.js';
import { profiler } from './ui/components/profiler-state.js';
import {
  createPermissionQueueStore,
  createContinuationPresenter,
} from './ui/permissions/permissionQueueStore.js';
import { PermissionQueueProvider } from './ui/permissions/PermissionQueueContext.js';
import { initializeConsoleStore } from './ui/hooks/useConsoleMessages.js';
import type { SessionBrowserOpenOptions } from './ui/hooks/useSessionBrowser.js';
import type { WorktreeStartupRequest } from './utils/worktreeStartupRequest.js';
import type { RebuildInteractiveProject } from './interactiveProjectRuntime.js';
import { useInteractiveProject } from './ui/hooks/useInteractiveProject.js';

import {
  CliApplicationContext,
  type CliApplicationView,
} from './ui/contexts/CliApplicationContext.js';
import { configureTuiEnvironment } from './ui/utils/tuiEnvironment.js';


function createTuiPermissionQueue(config: Config) {
  // 权限队列随项目重建，并在渲染前接好 Hook 与审批持久化，避免沿用旧项目权限。
  // Hook 拒绝并要求中断时，桥接层默认读取本次重建所属 Config 的中断槽位：
  // 当前轮次的 abort 由编排器挂载后装进同一个 Config，桥接层建得更早也拿得到，
  // 而项目重建换掉 Config 后，旧树的卸载清理不会误伤新树的桥接。
  const tuiHookBridge = createPermissionRequestHookBridge(config);
  const permissionQueueStore = createPermissionQueueStore({
    hookBridge: tuiHookBridge,
    onPromptShown: permissionPromptNotifier(config),
    getCurrentMode: () => config.getPermissionMode(),
    askMetrics: config.permissionTelemetry.askMetrics,
    onRemember: (scope, suggestions) => {
      // 队列早于会话权限对象创建；记住审批时才解析当前模块。
      const permission = config.permission;
      if (!permission) return;
      rememberApproval({
        permission,
        scope,
        suggestions,
        settingsWriter: permission.getSettingsWriter?.(),
        onModeChange: (mode) =>
          config.setPermissionMode(mode, { trigger: 'tool' }),
      });
    },
  });
  config.setPermissionAskHandler(permissionQueueStore.askHandler);
  // 重复调用保护也使用同一确认队列。
  config.confirmContinuation =
    createContinuationPresenter(permissionQueueStore);
  return permissionQueueStore;
}

export async function startInteractiveUI(
  AppContainer: AppContainerComponent,
  i18nService: I18nService,
  config: Config,
  settings: LoadedSettings,
  startupWarnings: StartupWarning[],
  _workspaceRoot: string = process.cwd(),
  resumedSessionData: SessionResumeData | undefined,
  themeError: string | null,
  initialSessionTitle: string | undefined,
  initialSessionBrowserOptions?: SessionBrowserOpenOptions,
  startupCoordinator?: StartupCoordinator,
  worktreeStartupRequest?: WorktreeStartupRequest,
  rebuildProject?: RebuildInteractiveProject,
  application?: CliApplicationView,
  sessionUi?: SessionUiBinding,
) {
  const hasSessionBinding = !!sessionUi;
  initializeConsoleStore();

  // Never enter Ink alternate buffer mode when screen reader mode is enabled
  // as there is no benefit of alternate buffer mode when using a screen reader
  // and the Ink alternate buffer mode requires line wrapping harmful to
  // screen readers.
  const useAlternateBuffer = shouldEnterAlternateScreen(
    config.getUseAlternateBuffer(),
    config.getScreenReader(),
  );
  const mouseEventsEnabled = useAlternateBuffer;
  if (mouseEventsEnabled) {
    enableMouseEvents();
    registerCleanup(() => {
      disableMouseEvents();
    });
  }

  const {
    matchers,
    config: keyBindingConfig,
    errors,
  } = await loadKeyMatchers();
  errors.forEach((error) => {
    coreEvents.emitFeedback('warning', error);
  });

  const version = await getVersion();
  setWindowTitle(initialSessionTitle ?? BRAND_CLI_NAME, settings);

  const consolePatcher = new ConsolePatcher({
    onNewMessage: (msg) => {
      coreEvents.emitConsoleLog(msg.type, msg.content);
    },
    debugMode: config.getDebugMode(),
  });
  consolePatcher.patch();
  // Use process 'exit' event instead of registerCleanup so consolePatcher stays
  // active throughout all async cleanup (hooks, et al.) and only restores
  // console at the very end — preventing debug/warn leaks to terminal on exit.
  process.on('exit', consolePatcher.cleanup);

  const { stdout: inkStdout, stderr: inkStderr } = createWorkingStdio();

  const isShpool = !!process.env['SHPOOL_SESSION_NAME'];
  const systemUiLocale = hasSessionBinding ? undefined : detectSystemUiLocale();

  const localeOptions = {
    forcedLocale: hasSessionBinding ? ('en' as const) : undefined,
    systemLocale: systemUiLocale,
    dynamicContentEnabled: !hasSessionBinding,
  };
  bindI18nSettings(i18nService, settings, localeOptions)();
  registerCleanup(bindUiLocale(i18nService));

  // Create wrapper component to use hooks inside render
  const AppWrapper = () => {
    useKittyKeyboardProtocol();
    const project = useInteractiveProject(
      { config, settings, themeError },
      rebuildProject,
    );
    const runtime = project.runtime;
    const permissionQueueStore = useMemo(
      () => (runtime ? createTuiPermissionQueue(runtime.config) : undefined),
      [runtime],
    );
    const activeConfig = runtime?.config;
    const activeSettings = runtime?.settings;
    const lastSettings = useRef(settings);
    useEffect(() => {
      if (activeSettings) lastSettings.current = activeSettings;
    }, [activeSettings]);
    useLayoutEffect(
      () =>
        bindI18nSettings(
          i18nService,
          activeSettings ?? lastSettings.current,
          localeOptions,
        ),
      [activeSettings],
    );
    useInput(
      (input, key) => {
        if (key.ctrl && input === 'c') void gracefulExit(1);
      },
      { isActive: !runtime },
    );

    const content =
      activeConfig && activeSettings && permissionQueueStore ? (
        <KeyMatchersProvider value={matchers} config={keyBindingConfig}>
          <KeypressProvider config={activeConfig}>
            <MouseProvider mouseEventsEnabled={mouseEventsEnabled}>
              <TerminalProvider>
                <ScrollProvider>
                  <OverflowProvider>
                    <SessionStatsProvider
                      getSessionId={() => activeConfig.getSessionId()}
                    >
                      <VimModeProvider>
                          <KeyboardContextProvider>
                            <AppFocusProvider>
                              <ActionHandlerRegistryProvider>
                                <FoldStateProvider>
                                  <PermissionQueueProvider
                                    store={permissionQueueStore}
                                  >
                                    <AppContainer
                                      config={activeConfig}
                                      startupWarnings={startupWarnings}
                                      version={version}
                                      resumedSessionData={
                                        project.resumedSessionData ??
                                        resumedSessionData
                                      }
                                      sessionUi={sessionUi}
                                      themeError={runtime.themeError}
                                      initialSessionTitle={
                                        project.resumedSessionData
                                          ? undefined
                                          : initialSessionTitle
                                      }
                                      initialSessionBrowserOptions={
                                        project.resumedSessionData
                                          ? undefined
                                          : initialSessionBrowserOptions
                                      }
                                      worktreeStartupRequest={
                                        project.resumedSessionData
                                          ? undefined
                                          : worktreeStartupRequest
                                      }
                                      onProjectResume={
                                        rebuildProject
                                          ? project.resume
                                          : undefined
                                      }
                                      initialResumeOptions={
                                        project.resumeOptions
                                      }
                                      onInitialResumeComplete={
                                        project.resumedSessionData
                                          ? project.onInitialResumeComplete
                                          : undefined
                                      }
                                      initialPromptSubmittedRef={
                                        project.initialPromptSubmitted
                                      }
                                    />
                                  </PermissionQueueProvider>
                                </FoldStateProvider>
                              </ActionHandlerRegistryProvider>
                            </AppFocusProvider>
                          </KeyboardContextProvider>
                      </VimModeProvider>
                    </SessionStatsProvider>
                  </OverflowProvider>
                </ScrollProvider>
              </TerminalProvider>
            </MouseProvider>
          </KeypressProvider>
        </KeyMatchersProvider>
      ) : (
        <Text>
          <T
            id={
              project.error
                ? 'session.projectRestore.failed'
                : 'session.projectRestore.loading'
            }
          />
        </Text>
      );

    // 旧项目卸载后仍保留语言设置，恢复中和失败提示不依赖已释放的 Config。
    const localizedContent = (
      <SettingsContext.Provider value={activeSettings ?? lastSettings.current}>
        <I18nServiceProvider service={i18nService}>
          <CliApplicationContext.Provider value={application}>
            {content}
          </CliApplicationContext.Provider>
        </I18nServiceProvider>
      </SettingsContext.Provider>
    );

    if (useAlternateBuffer) {
      return (
        <AlternateScreen mouseTracking={mouseEventsEnabled}>
          {localizedContent}
        </AlternateScreen>
      );
    }

    return localizedContent;
  };

  if (isShpool) {
    // Wait a moment for shpool to stabilize terminal size and state.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  terminalCapabilityManager.stopDraining();
  configureTuiEnvironment({});
  let reportedTuiOnlyFirstRendered = false;

  const instance = render(
    process.env['DEBUG'] ? (
      <React.StrictMode>
        <AppWrapper />
      </React.StrictMode>
    ) : (
      <AppWrapper />
    ),
    {
      stdout: inkStdout,
      stderr: inkStderr,
      stdin: process.stdin,
      exitOnCtrlC: false,
      isScreenReaderEnabled: config.getScreenReader(),
      onRender: () => {
        if (!reportedTuiOnlyFirstRendered) {
          reportedTuiOnlyFirstRendered = true;
          markStartupMilestone('tui_first_frame', undefined, {
            alternate_buffer: useAlternateBuffer,
          });
        }
        profiler.reportFrameRendered();
      },
      // CC Ink engine deprecations: terminalBuffer, renderProcess,
      // incrementalRendering, standardReactLayoutTiming are no longer needed —
      // the engine uses in-process double buffering, cell-level diffing, and
      // microtask-deferred rendering by default.
      patchConsole: false,
      alternateBuffer: useAlternateBuffer,
    },
  );

  startupCoordinator?.startAfterFirstRenderCleanup(config, {
    // The session browser may still need any historical transcript. Avoid
    // recording project cleanup as complete until a later normal startup.
    includeProjectCleanup: initialSessionBrowserOptions === undefined,
  });

  if (useAlternateBuffer) {
    disableLineWrapping();
    registerCleanup(() => {
      enableLineWrapping();
    });
  }

  registerCleanup(() => instance.unmount());

  registerCleanup(setupTtyCheck());
}

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.ui.hideWindowTitle) {
    // Initial state before React loop starts
    const windowTitle = computeTerminalTitle({
      streamingState: StreamingState.Idle,
      isConfirming: false,
      sessionTitle: title,
      useDynamicTitle: settings.merged.ui.dynamicWindowTitle,
    });
    writeToStdout(`\x1b]0;${windowTitle}\x07`);

    process.on('exit', () => {
      writeToStdout(`\x1b]0;\x07`);
    });
  }
}
