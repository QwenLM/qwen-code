/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mounts the active OpenTUI dialog (R2 product integration). The dispatcher
 * resolves dialog requests onto a `MountedDialog`; the backend renders this
 * component in place of the idle prompt area and hands it the live config /
 * settings / command registry. Close, cancel and result flows route back to
 * the backend through `onClose` / `onNavigate` / `notify`.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from '@opentui/react';
import type { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { SlashCommand } from '../commands/types.js';
import { themeManager } from '../themes/theme-manager.js';
import { toOriginalKey } from './key-map.js';
import type { MountedDialog } from './command-bridge.js';
import { HelpOverlay, helpScrollMax } from './help-overlay.js';
import {
  buildHelpCommandsLines,
  buildHelpCustomCommandLines,
  computeHelpBodyRows,
  HELP_TABS,
  type HelpTab,
} from './help-content.js';
import { OpenTuiThemeDialog } from './dialogs-theme.js';
import { OpenTuiSettingsDialog } from './dialogs-settings.js';
import { OpenTuiModelDialog, type ModelDialogMode } from './dialogs-model.js';
import { OpenTuiPermissionsDialog } from './dialogs-permissions.js';
import {
  EXTENSIONS_TABS,
  OpenTuiExtensionsDialog,
  type ExtensionRow,
  type ExtensionsStatusMessage,
} from './dialogs-extensions.js';
import { OpenTuiMcpDialog, type McpServerInfo } from './dialogs-mcp.js';
import {
  OpenTuiStatsDialog,
  OpenTuiSkillsDialog,
} from './dialogs-stats-skills.js';
import {
  OpentuiRewindSelector,
  type RestoreOption,
  type RewindDiffStats,
  type RewindTurn,
} from './session-rewind.js';
import {
  OpenTuiApprovalModeDialog,
  OpenTuiEffortDialog,
} from './dialogs-modes.js';
import {
  OpenTuiMemoryDialog,
  OpenTuiStatusLineDialog,
} from './dialogs-memory-status.js';
import {
  OpenTuiEditorDialog,
  OpenTuiTrustDialog,
  OpenTuiDeleteDialog,
  OpenTuiResumeDialog,
  OpenTuiBranchDialog,
  OpenTuiHooksDialog,
  OpenTuiRewindDialog,
  OpenTuiDiffDialog,
  OpenTuiSubagentCreateDialog,
  OpenTuiSubagentListDialog,
} from './dialogs-misc.js';
import { OpenTuiArenaDialog } from './dialogs-arena.js';
import { OpenTuiAuthDialog } from './dialogs-auth.js';
import {
  addPermissionRule,
  applyExtensionFavorite,
  applyExtensionScopeChange,
  applyExtensionToggle,
  applyExtensionUninstall,
  applyExtensionUpdate,
  applyExtensionUpdateCheck,
  applyMcpServerAction,
  applyModelSelection,
  applyThemeSelection,
  buildExtensionRows,
  buildMcpServers,
  buildModelEntries,
  buildPermissionsData,
  computeModelDialogInitialKey,
  deletePermissionRule,
  enrichMcpOAuthState,
  getMcpServerResources,
  getMcpServerTools,
  type ExtensionActionResult,
} from './dialog-data.js';

/** The data the mounted rewind selector needs from the backend. */
export interface OpenTuiRewindData {
  turns: readonly RewindTurn[];
  fileCheckpointingEnabled: boolean;
  getDiffStats?: (promptId: string) => Promise<RewindDiffStats | undefined>;
  onRewind: (turn: RewindTurn, option: RestoreOption) => void | Promise<void>;
}

export interface OpenTuiDialogMountProps {
  dialog: MountedDialog;
  config?: Config;
  settings: LoadedSettings;
  /** The real interactive command registry (help overlay content). */
  commands: readonly SlashCommand[];
  onClose: () => void;
  /** Switch the mounted dialog (settings → theme/model sub-dialogs). */
  onNavigate: (dialog: MountedDialog) => void;
  /**
   * Re-resolve the rendering palette for a theme name (settings `ui.theme`
   * face): highlight previews, selections and cancels in the /theme dialog
   * route through here so the change is visible immediately.
   */
  onThemeChanged: (themeName: string | undefined) => void;
  /** Append a command-style message to the chat history. */
  notify: (text: string) => void;
  onApprovalModeChanged: (mode: ApprovalMode) => void;
  /** Resume picker selection → the real session switch (host.handleResume). */
  onResume?: (sessionId: string) => void;
  /** Rewind selector data (turns come from the backend transcript). */
  rewind?: OpenTuiRewindData;
  /** Fill the composer without submitting (arena start model selection). */
  onFillInput?: (text: string) => void;
}

function HelpDialogHost(props: {
  commands: readonly SlashCommand[];
  onClose: () => void;
}) {
  const { commands, onClose } = props;
  const [tab, setTab] = useState<HelpTab>('general');
  const [scroll, setScroll] = useState(0);
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  // Plain raw Escape, consumed at the renderer level before parsed-key
  // dispatch: closes the overlay even though the composer still owns focus
  // while the dialog is mounted. Ctrl+C (\x03) and every other sequence fall
  // through untouched.
  useLayoutEffect(() => {
    const onRawInput = (sequence: string): boolean => {
      if (sequence !== '\x1b') return false;
      onClose();
      return true;
    };
    renderer.addInputHandler(onRawInput);
    return () => renderer.removeInputHandler(onRawInput);
  }, [renderer, onClose]);
  useKeyboard((key) => {
    const original = toOriginalKey(key);
    if (original.name === 'tab') {
      const order = HELP_TABS.map(({ tab: helpTab }) => helpTab);
      const index = order.indexOf(tab);
      const next =
        (index + (original.shift ? -1 : 1) + order.length) % order.length;
      setTab(order[next] ?? 'general');
      setScroll(0);
      return;
    }
    if (tab === 'general') return;
    // Same width the overlay hands the line builders, so the scroll bounds
    // match the lines that actually render.
    const linesWidth = Math.max(72, width - 4);
    const lines =
      tab === 'commands'
        ? buildHelpCommandsLines(commands, linesWidth)
        : buildHelpCustomCommandLines(commands, linesWidth);
    const maxScroll = helpScrollMax(lines);
    if (original.name === 'up') setScroll((s) => Math.max(0, s - 1));
    if (original.name === 'down') setScroll((s) => Math.min(maxScroll, s + 1));
  });
  return (
    <HelpOverlay
      commands={commands}
      tab={tab}
      scroll={scroll}
      bodyRows={computeHelpBodyRows(height)}
      width={width - 4}
    />
  );
}

function ThemeDialogHost(props: {
  settings: LoadedSettings;
  onClose: () => void;
  notify: (text: string) => void;
  onThemeChanged: (themeName: string | undefined) => void;
}) {
  // Parity of useThemeCommand: Esc cancels and restores the pre-dialog theme.
  // The restore source is the CONFIGURED theme (undefined = adaptive), not the
  // manager's resolved active name, so cancelling an Auto session restores
  // Auto instead of pinning whatever the probe resolved.
  const themeBeforeOpen = useRef<string | undefined>(
    props.settings.merged.ui?.theme,
  );
  return (
    <OpenTuiThemeDialog
      settings={props.settings}
      onSelect={(themeName, scope) => {
        if (themeName === undefined) {
          themeManager.setActiveTheme(themeBeforeOpen.current);
          props.onThemeChanged(themeBeforeOpen.current);
          props.onClose();
          return;
        }
        const result = applyThemeSelection(props.settings, themeName, scope);
        if (result.error) {
          props.notify(result.error);
        } else if (result.applied) {
          props.notify(`Theme set to ${result.applied}.`);
        }
        props.onThemeChanged(themeName);
        props.onClose();
      }}
      onHighlight={(themeName) => {
        themeManager.setActiveTheme(themeName);
        props.onThemeChanged(themeName);
      }}
    />
  );
}

function SettingsDialogHost(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  onNavigate: (dialog: MountedDialog) => void;
  notify: (text: string) => void;
  onApprovalModeChanged: (mode: ApprovalMode) => void;
}) {
  return (
    <OpenTuiSettingsDialog
      settings={props.settings}
      config={props.config}
      onSelect={(settingName) => {
        if (settingName === undefined) {
          props.onClose();
          return;
        }
        if (settingName === 'ui.theme') {
          props.onNavigate({ dialog: 'theme' });
          return;
        }
        if (settingName === 'fastModel') {
          props.onNavigate({ dialog: 'model', mode: 'fast' });
          return;
        }
        if (settingName === 'visionModel') {
          props.onNavigate({ dialog: 'model', mode: 'vision' });
          return;
        }
        if (settingName === 'general.preferredEditor') {
          props.onNavigate({ dialog: 'editor' });
          return;
        }
        props.onClose();
      }}
      onRestartRequest={() => process.exit(0)}
      onSettingApplied={(key, value) => {
        if (key === 'tools.approvalMode') {
          const mode = value as ApprovalMode;
          props.config?.setApprovalMode(mode);
          props.onApprovalModeChanged(mode);
        }
      }}
    />
  );
}

function ModelDialogHost(props: {
  mode: ModelDialogMode;
  persistScope?: 'workspace' | 'user';
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  notify: (text: string) => void;
}) {
  const { height } = useTerminalDimensions();
  const entries = useMemo(
    () => buildModelEntries(props.config, props.mode),
    [props.config, props.mode],
  );
  // Highlight the current model on open (ink ModelDialog `preferredKey`
  // parity) instead of always starting on the first row.
  const initialKey = useMemo(
    () =>
      computeModelDialogInitialKey({
        config: props.config,
        settings: props.settings,
        entries,
        mode: props.mode,
      }),
    [props.config, props.settings, entries, props.mode],
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  return (
    <OpenTuiModelDialog
      entries={entries}
      mode={props.mode}
      authType={props.config?.getAuthType()}
      persistScope={props.persistScope}
      initialKey={initialKey}
      availableTerminalHeight={height}
      errorMessage={errorMessage}
      onSelect={(selectionKey) => {
        setErrorMessage(null);
        void applyModelSelection({
          config: props.config,
          settings: props.settings,
          entries,
          mode: props.mode,
          selectionKey,
          ...(props.persistScope ? { persistScope: props.persistScope } : {}),
        }).then((outcome) => {
          if (!outcome.ok) {
            // Validation/runtime switch failed: keep the dialog open and show
            // the error, exactly like the ink ModelDialog (never persist).
            setErrorMessage(outcome.error);
            return;
          }
          if (outcome.message) {
            props.notify(outcome.message);
          }
          props.onClose();
        });
      }}
      onClose={props.onClose}
    />
  );
}

function PermissionsDialogHost(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const data = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    refreshKey; // nonce: re-read rules/directories after every mutation
    return buildPermissionsData(props.config);
  }, [props.config, refreshKey]);
  const workspace = props.config?.getWorkspaceContext();
  return (
    <OpenTuiPermissionsDialog
      rules={data.rules}
      directories={data.directories}
      initialDirectories={data.initialDirectories}
      onAddRule={(ruleText, type, scope) => {
        addPermissionRule(props.config, props.settings, ruleText, type, scope);
        setRefreshKey((key) => key + 1);
      }}
      onDeleteRule={(raw, type) => {
        deletePermissionRule(props.config, props.settings, raw, type);
        setRefreshKey((key) => key + 1);
      }}
      onAddDirectory={(resolvedDir) => {
        workspace?.addDirectory(resolvedDir);
        setRefreshKey((key) => key + 1);
      }}
      onRemoveDirectory={(dir) => {
        workspace?.removeDirectory(dir);
        setRefreshKey((key) => key + 1);
      }}
      onExit={props.onClose}
    />
  );
}

/**
 * MCP host (audit 01 G-6 / 05 G-13): loads the server inventory with the
 * REAL OAuth token state (enrichMcpOAuthState), feeds tools/resources, and
 * runs the server actions through applyMcpServerAction (enable/disable,
 * reconnect, approve, authenticate, clear-auth), reloading after changes.
 */
function McpDialogHost(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  notify: (text: string) => void;
}) {
  const { config, settings, onClose, notify } = props;
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    void enrichMcpOAuthState(config, buildMcpServers(config)).then((list) => {
      if (alive) setServers(list);
    });
    return () => {
      alive = false;
    };
  }, [config, version]);
  return (
    <OpenTuiMcpDialog
      servers={servers}
      getServerTools={(server) => getMcpServerTools(config, server.name)}
      getServerResources={(server) =>
        getMcpServerResources(config, server.name)
      }
      onClose={onClose}
      onServerAction={(server, action) => {
        void applyMcpServerAction(config, settings, server, action).then(
          (result) => {
            if (result.message) notify(result.message);
            if (result.changed) setVersion((v) => v + 1);
          },
        );
      }}
    />
  );
}

/**
 * Extensions host (audit 01 G-4 / 05 G-12): feeds the Installed rows and
 * runs the management actions (Space enable/disable, f favorite, detail
 * toggle/favorite/scope/update/uninstall) through the extension manager,
 * reloading the rows after every mutation and surfacing the result as the
 * in-dialog status message (ink InstalledTab parity).
 */
function ExtensionsDialogHost(props: { config?: Config; onClose: () => void }) {
  const [rows, setRows] = useState<ExtensionRow[]>([]);
  const [status, setStatus] = useState<ExtensionsStatusMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setRows(buildExtensionRows(props.config));
  }, [props.config, version]);

  const runAction = (
    fn: () => ExtensionActionResult | Promise<ExtensionActionResult>,
  ) => {
    setBusy(true);
    void Promise.resolve(fn())
      .then((result) => {
        setStatus({ type: result.level, text: result.message });
        if (result.changed) setVersion((value) => value + 1);
      })
      .finally(() => setBusy(false));
  };

  return (
    <OpenTuiExtensionsDialog
      onClose={props.onClose}
      status={status}
      busy={busy}
      rowsByTab={{ [EXTENSIONS_TABS.INSTALLED]: rows }}
      onRowAction={(row, action) => {
        if (action === 'toggle') {
          runAction(() =>
            applyExtensionToggle(props.config, row.key, row.enabled !== false),
          );
        } else {
          runAction(() => applyExtensionFavorite(props.config, row.key));
        }
      }}
      onDetailAction={(row, action, arg) => {
        if (action === 'mark-update') {
          return applyExtensionUpdateCheck(props.config, row.key).then(
            (result) => {
              setStatus({
                type: result.state === 'error' ? 'error' : 'info',
                text: result.message,
              });
              return result.state;
            },
          );
        }
        switch (action) {
          case 'toggle':
            runAction(() =>
              applyExtensionToggle(
                props.config,
                row.key,
                row.enabled !== false,
              ),
            );
            break;
          case 'favorite':
            runAction(() => applyExtensionFavorite(props.config, row.key));
            break;
          case 'change-scope':
            runAction(() =>
              applyExtensionScopeChange(props.config, row.key, arg ?? 'user'),
            );
            break;
          case 'uninstall':
            runAction(() => applyExtensionUninstall(props.config, row.key));
            break;
          case 'update':
            runAction(() => applyExtensionUpdate(props.config, row.key));
            break;
          default:
            break;
        }
        return undefined;
      }}
    />
  );
}

export function OpenTuiDialogMount(props: OpenTuiDialogMountProps) {
  const { dialog, config, settings, commands, onClose, onNavigate, notify } =
    props;
  return (
    <box
      flexDirection="column"
      marginLeft={1}
      marginRight={1}
      marginTop={1}
      flexShrink={0}
    >
      {dialog.dialog === 'help' && (
        <HelpDialogHost commands={commands} onClose={onClose} />
      )}
      {dialog.dialog === 'theme' && (
        <ThemeDialogHost
          settings={settings}
          onClose={onClose}
          notify={notify}
          onThemeChanged={props.onThemeChanged}
        />
      )}
      {dialog.dialog === 'settings' && (
        <SettingsDialogHost
          config={config}
          settings={settings}
          onClose={onClose}
          onNavigate={onNavigate}
          notify={notify}
          onApprovalModeChanged={props.onApprovalModeChanged}
        />
      )}
      {dialog.dialog === 'model' && (
        <ModelDialogHost
          mode={dialog.mode}
          persistScope={dialog.persistScope}
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      )}
      {dialog.dialog === 'permissions' && (
        <PermissionsDialogHost
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'extensions_manage' && (
        <ExtensionsDialogHost config={config} onClose={onClose} />
      )}
      {dialog.dialog === 'mcp' && (
        <McpDialogHost
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      )}
      {dialog.dialog === 'stats' && (
        <OpenTuiStatsDialog config={config} onClose={onClose} />
      )}
      {dialog.dialog === 'skills_manage' && (
        <OpenTuiSkillsDialog config={config} onClose={onClose} />
      )}
      {dialog.dialog === 'approval-mode' && (
        <OpenTuiApprovalModeDialog
          config={config}
          settings={settings}
          onClose={onClose}
          onApprovalModeChanged={props.onApprovalModeChanged}
        />
      )}
      {dialog.dialog === 'effort' && (
        <OpenTuiEffortDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'memory' && (
        <OpenTuiMemoryDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'statusline' && (
        <OpenTuiStatusLineDialog settings={settings} onClose={onClose} />
      )}
      {dialog.dialog === 'editor' && (
        <OpenTuiEditorDialog
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      )}
      {dialog.dialog === 'auth' && (
        <OpenTuiAuthDialog
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      )}
      {dialog.dialog === 'trust' && (
        <OpenTuiTrustDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'delete' && (
        <OpenTuiDeleteDialog
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      )}
      {dialog.dialog === 'resume' && (
        <OpenTuiResumeDialog
          config={config}
          settings={settings}
          onClose={onClose}
          matchedSessions={dialog.matchedSessions}
          onSelect={props.onResume}
        />
      )}
      {dialog.dialog === 'branch' && (
        <OpenTuiBranchDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'hooks' && (
        <OpenTuiHooksDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'rewind' &&
        (props.rewind ? (
          // The full multi-phase selector (session-rewind.tsx) wired to the
          // backend's transcript turns (audit 01 G-8 / 05 G-07).
          <OpentuiRewindSelector
            turns={props.rewind.turns}
            fileCheckpointingEnabled={props.rewind.fileCheckpointingEnabled}
            getDiffStats={props.rewind.getDiffStats}
            onRewind={props.rewind.onRewind}
            onCancel={onClose}
          />
        ) : (
          <OpenTuiRewindDialog
            config={config}
            settings={settings}
            onClose={onClose}
          />
        ))}
      {dialog.dialog === 'diff' && (
        <OpenTuiDiffDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'arena' && (
        <OpenTuiArenaDialog
          config={config}
          mode={dialog.mode}
          onClose={onClose}
          notify={notify}
          onFillInput={props.onFillInput}
        />
      )}
      {dialog.dialog === 'subagent_create' && (
        <OpenTuiSubagentCreateDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
      {dialog.dialog === 'subagent_list' && (
        <OpenTuiSubagentListDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      )}
    </box>
  );
}
