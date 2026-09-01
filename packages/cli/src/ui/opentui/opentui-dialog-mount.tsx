/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dialog mounting for the OpenTUI backend (Batch 5 slice 2).
 *
 * Maps one {@link OpenTuiDialogRequest} (produced by the slash dispatcher via
 * `routeDialogToOpenTui`) to the matching Batch-4 dialog component, wiring its
 * data (through `dialog-data.ts` builders) and its callbacks (through the
 * injected host / shell seams). The app-shell renders this as
 * `<OpenTuiDialogMount key={request.dialog} …/>` so dialog-local state
 * (permissions list, mcp inventory, extension rows, model error) resets on
 * every dialog change — every React hook here therefore runs unconditionally
 * and gates on `request.dialog` internally.
 *
 * Not ink `AppContainer`'s `dialogOpen` switch verbatim: several dialogs here
 * resolve through `onSelect` rather than a shared `onClose`, so the close/apply
 * handling is per-case.
 */

import { useEffect, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type {
  ApprovalMode,
  Config,
  SessionListItem,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings, SettingScope } from '../../config/settings.js';
import type { SlashCommand } from '../commands/types.js';
import type { OpenTuiDialogRequest } from './commands-registry.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import { toOriginalKey } from './key-map.js';
import { HelpOverlay } from './help-overlay.js';
import {
  computeHelpBodyRows,
  HELP_TABS,
  type HelpTab,
} from './help-content.js';
import {
  applyThemeSelection,
  applyMcpServerAction,
  applyModelSelection,
  addPermissionRule,
  buildExtensionRows,
  buildMcpServers,
  buildModelEntries,
  buildPermissionsData,
  computeModelDialogInitialKey,
  deletePermissionRule,
  enrichMcpOAuthState,
  getMcpServerResources,
  getMcpServerTools,
  applyExtensionFavorite,
  applyExtensionScopeChange,
  applyExtensionToggle,
  applyExtensionUninstall,
  applyExtensionUpdate,
  applyExtensionUpdateCheck,
} from './dialog-data.js';
import { OpenTuiThemeDialog } from './dialogs-theme.js';
import { OpenTuiSettingsDialog } from './dialogs-settings.js';
import { OpenTuiModelDialog } from './dialogs-model.js';
import {
  OpenTuiExtensionsDialog,
  type ExtensionDetailAction,
  type ExtensionsStatusMessage,
  type ExtensionsTab,
  type ExtensionRow,
} from './dialogs-extensions.js';
import {
  OpenTuiMcpDialog,
  type McpServerAction,
  type McpServerInfo,
} from './dialogs-mcp.js';
import { OpenTuiPermissionsDialog } from './dialogs-permissions.js';
import { OpenTuiAuthDialog } from './dialogs-auth.js';
import { OpenTuiArenaDialog } from './dialogs-arena.js';
import {
  OpenTuiMemoryDialog,
  OpenTuiStatusLineDialog,
} from './dialogs-memory-status.js';
import {
  OpenTuiApprovalModeDialog,
  OpenTuiEffortDialog,
} from './dialogs-modes.js';
import {
  OpenTuiStatsDialog,
  OpenTuiSkillsDialog,
} from './dialogs-stats-skills.js';
import {
  OpenTuiDeleteDialog,
  OpenTuiDiffDialog,
  OpenTuiEditorDialog,
  OpenTuiHooksDialog,
  OpenTuiResumeDialog,
  OpenTuiRewindDialog,
  OpenTuiSubagentCreateDialog,
  OpenTuiSubagentListDialog,
  OpenTuiTrustDialog,
} from './dialogs-misc.js';

export interface OpenTuiDialogMountProps {
  request: OpenTuiDialogRequest;
  host: OpenTuiAppHost;
  config: Config;
  settings: LoadedSettings;
  /** Interactive command registry — drives the help overlay. */
  commands: readonly SlashCommand[];
  onClose: () => void;
  notify: (text: string) => void;
  /** Writes text into the composer (arena "fill input", slash re-inject). */
  fillInput?: (text: string) => void;
  /** Applies a setting chosen in the settings dialog (shell-owned). */
  onSelectSetting?: (name: string, scope: SettingScope) => void;
  /** Notifies the shell that the approval mode changed (spinner/prompt sync). */
  onApprovalModeChanged?: (mode: ApprovalMode) => void;
  /** Row budget for the model/settings/theme dialog bodies. */
  availableTerminalHeight?: number;
}

export function OpenTuiDialogMount(props: OpenTuiDialogMountProps) {
  const { request, host, config, settings, commands, onClose, notify } = props;
  const isHelp = request.dialog === 'help';
  const dimensions = useTerminalDimensions();

  // --- permission rules (rebuild after add/delete) ------------------------
  const [permissions, setPermissions] = useState(() =>
    request.dialog === 'permissions' ? buildPermissionsData(config) : null,
  );
  const reloadPermissions = () => setPermissions(buildPermissionsData(config));

  // --- mcp inventory (async OAuth enrich on open) -------------------------
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  useEffect(() => {
    if (request.dialog !== 'mcp') return;
    let alive = true;
    const initial = buildMcpServers(config);
    setMcpServers(initial);
    void enrichMcpOAuthState(config, initial).then((enriched) => {
      if (alive) setMcpServers(enriched);
    });
    return () => {
      alive = false;
    };
  }, [request.dialog, config]);

  const runMcpAction = (server: McpServerInfo, action: McpServerAction) => {
    void applyMcpServerAction(config, settings, server, action).then(
      (result) => {
        if (result.message) notify(result.message);
        if (result.changed) {
          const next = buildMcpServers(config);
          setMcpServers(next);
          void enrichMcpOAuthState(config, next).then(setMcpServers);
        }
      },
    );
  };

  // --- extension management (rows / busy / status / discover filter) ------
  const [extRows, setExtRows] = useState<readonly ExtensionRow[]>(() =>
    request.dialog === 'extensions_manage' ? buildExtensionRows(config) : [],
  );
  const [extBusy, setExtBusy] = useState(false);
  const [extStatus, setExtStatus] = useState<ExtensionsStatusMessage | null>(
    null,
  );
  const [extDiscoverFilter, setExtDiscoverFilter] = useState<string | null>(
    null,
  );
  const reloadExtensions = () => setExtRows(buildExtensionRows(config));
  const reportExtension = (
    message: string,
    level: string,
    changed: boolean,
  ) => {
    setExtStatus({
      type: level as ExtensionsStatusMessage['type'],
      text: message,
    });
    if (changed) reloadExtensions();
  };

  const runExtensionAction = (
    name: string,
    action: ExtensionDetailAction | 'toggle',
    arg?: unknown,
  ) => {
    setExtBusy(true);
    const settle = (
      r: { message: string; changed: boolean; level: string } | void,
    ) => {
      setExtBusy(false);
      if (r) reportExtension(r.message, r.level, r.changed);
    };
    switch (action) {
      case 'toggle':
        void applyExtensionToggle(
          config,
          name,
          extRows.find((row) => row.key === name)?.enabled ?? false,
        ).then(settle);
        break;
      case 'favorite':
        settle(applyExtensionFavorite(config, name));
        break;
      case 'uninstall':
        void applyExtensionUninstall(config, name).then(settle);
        break;
      case 'change-scope':
        void applyExtensionScopeChange(
          config,
          name,
          arg as 'user' | 'project',
        ).then(settle);
        break;
      case 'update':
        void applyExtensionUpdate(config, name).then(settle);
        break;
      case 'mark-update':
        void applyExtensionUpdateCheck(config, name).then((state) => {
          setExtBusy(false);
          if (state) setExtStatus({ type: 'info', text: 'Update available.' });
        });
        break;
      default: {
        const exhaustive: never = action;
        void exhaustive;
      }
    }
  };

  // --- model dialog error (kept open on failed selection) -----------------
  const [modelError, setModelError] = useState<string | null>(null);

  // --- help overlay interaction -------------------------------------------
  const [helpTab, setHelpTab] = useState<HelpTab>('commands');
  const [helpScroll, setHelpScroll] = useState(0);

  useKeyboard((key) => {
    if (!isHelp) return;
    const { name } = toOriginalKey(key);
    if (name === 'escape' || name === 'q') {
      onClose();
      return;
    }
    const tabCount = HELP_TABS.length;
    const activeIndex = HELP_TABS.findIndex((entry) => entry.tab === helpTab);
    if (name === 'tab' || name === 'right') {
      setHelpTab(HELP_TABS[(activeIndex + 1) % tabCount]!.tab);
      setHelpScroll(0);
    } else if (name === 'left') {
      setHelpTab(HELP_TABS[(activeIndex - 1 + tabCount) % tabCount]!.tab);
      setHelpScroll(0);
    } else if (name === 'down' || name === 'j') {
      setHelpScroll((prev) => prev + 1);
    } else if (name === 'up' || name === 'k') {
      setHelpScroll((prev) => Math.max(0, prev - 1));
    }
  });

  // --- per-request rendering ----------------------------------------------

  switch (request.dialog) {
    case 'help': {
      const bodyRows = computeHelpBodyRows(dimensions.height);
      return (
        <HelpOverlay
          commands={commands}
          tab={helpTab}
          scroll={Math.max(0, helpScroll)}
          bodyRows={bodyRows}
          width={dimensions.width}
        />
      );
    }

    case 'theme':
      return (
        <OpenTuiThemeDialog
          settings={settings}
          availableTerminalHeight={props.availableTerminalHeight}
          onHighlight={() => {}}
          onSelect={(themeName, scope) => {
            const result = applyThemeSelection(settings, themeName, scope);
            if (result.error) notify(result.error);
            else if (result.applied) notify(`Theme set to ${result.applied}.`);
            onClose();
          }}
        />
      );

    case 'settings':
      return (
        <OpenTuiSettingsDialog
          settings={settings}
          config={config}
          availableTerminalHeight={props.availableTerminalHeight}
          onSelect={(name, scope) => {
            if (name === undefined) {
              onClose();
              return;
            }
            props.onSelectSetting?.(name, scope);
            onClose();
          }}
        />
      );

    case 'statusline':
      return <OpenTuiStatusLineDialog settings={settings} onClose={onClose} />;

    case 'memory':
      return (
        <OpenTuiMemoryDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      );

    case 'auth':
      return (
        <OpenTuiAuthDialog
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      );

    case 'editor':
      return (
        <OpenTuiEditorDialog
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      );

    case 'trust':
      return (
        <OpenTuiTrustDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      );

    case 'permissions': {
      const data = permissions ?? buildPermissionsData(config);
      return (
        <OpenTuiPermissionsDialog
          rules={data.rules}
          directories={data.directories}
          initialDirectories={data.initialDirectories}
          onAddRule={(ruleText, type, scope) => {
            addPermissionRule(config, settings, ruleText, type, scope);
            reloadPermissions();
          }}
          onDeleteRule={(raw, type) => {
            deletePermissionRule(config, settings, raw, type);
            reloadPermissions();
          }}
          onAddDirectory={() => {}}
          onRemoveDirectory={() => {}}
          onExit={onClose}
        />
      );
    }

    case 'approval-mode':
      return (
        <OpenTuiApprovalModeDialog
          config={config}
          settings={settings}
          onClose={onClose}
          onApprovalModeChanged={(mode) => {
            props.onApprovalModeChanged?.(mode);
            onClose();
          }}
        />
      );

    case 'effort':
      return (
        <OpenTuiEffortDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      );

    case 'delete':
      return (
        <OpenTuiDeleteDialog
          config={config}
          settings={settings}
          onClose={onClose}
          notify={notify}
        />
      );

    case 'resume':
      return (
        <OpenTuiResumeDialog
          config={config}
          settings={settings}
          onClose={onClose}
          matchedSessions={
            request.matchedSessions as SessionListItem[] | undefined
          }
          onSelect={(sessionId) => {
            void host.handleResume(sessionId).catch((error: unknown) => {
              notify(error instanceof Error ? error.message : String(error));
            });
            onClose();
          }}
        />
      );

    case 'extensions_manage': {
      const rowsByTab: Partial<Record<ExtensionsTab, readonly ExtensionRow[]>> =
        { installed: extRows };
      return (
        <OpenTuiExtensionsDialog
          onClose={onClose}
          status={extStatus}
          busy={extBusy}
          discoverFilter={extDiscoverFilter}
          onDiscoverFilterChange={setExtDiscoverFilter}
          rowsByTab={rowsByTab}
          onRowAction={(row, action) =>
            runExtensionAction(row.key, action as ExtensionDetailAction)
          }
          onDetailAction={(row, action, arg) => {
            runExtensionAction(row.key, action, arg);
            return undefined;
          }}
        />
      );
    }

    case 'hooks':
      return (
        <OpenTuiHooksDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      );

    case 'mcp':
      return (
        <OpenTuiMcpDialog
          servers={mcpServers}
          getServerTools={(server) => getMcpServerTools(config, server.name)}
          getServerResources={(server) =>
            getMcpServerResources(config, server.name)
          }
          onClose={onClose}
          onServerAction={runMcpAction}
        />
      );

    case 'rewind':
      // The real turn-scoped rewind selector needs the host's committed turn
      // list + a rewind action that is not part of the command-host surface;
      // Batch 5 mounts the self-contained placeholder (Batch 6 wires the
      // full selector into the shell transcript).
      return <OpenTuiRewindDialog settings={settings} onClose={onClose} />;

    case 'diff':
      return <OpenTuiDiffDialog settings={settings} onClose={onClose} />;

    case 'stats':
      return <OpenTuiStatsDialog config={config} onClose={onClose} />;

    case 'arena':
      return (
        <OpenTuiArenaDialog
          config={config}
          mode={request.mode}
          onClose={onClose}
          notify={notify}
          onFillInput={props.fillInput}
        />
      );

    case 'subagent_create':
      return (
        <OpenTuiSubagentCreateDialog settings={settings} onClose={onClose} />
      );

    case 'subagent_list':
      return (
        <OpenTuiSubagentListDialog
          config={config}
          settings={settings}
          onClose={onClose}
        />
      );

    case 'skills_manage':
      return <OpenTuiSkillsDialog config={config} onClose={onClose} />;

    case 'model': {
      const entries = buildModelEntries(config, request.mode);
      const initialKey = computeModelDialogInitialKey({
        config,
        settings,
        entries,
        mode: request.mode,
      });
      return (
        <OpenTuiModelDialog
          entries={entries}
          mode={request.mode}
          persistScope={request.persistScope}
          initialKey={initialKey}
          errorMessage={modelError}
          availableTerminalHeight={props.availableTerminalHeight}
          onClose={onClose}
          onSelect={(selectionKey) => {
            void applyModelSelection({
              config,
              settings,
              entries,
              mode: request.mode,
              selectionKey,
              persistScope: request.persistScope,
            }).then((outcome) => {
              if (outcome.ok) {
                setModelError(null);
                if (outcome.message) notify(outcome.message);
                onClose();
              } else {
                setModelError(outcome.error);
              }
            });
          }}
        />
      );
    }

    default: {
      const unhandled: never = request;
      throw new Error(
        `Unhandled OpenTUI dialog request: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}
