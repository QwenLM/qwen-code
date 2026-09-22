/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compact native OpenTUI dialogs for the remaining long-tail commands
 * (M3, #8677): editor/auth/trust/delete/resume/branch/rewind/diff/
 * arena/subagent_create/subagent_list. Each mounts a real panel (info or
 * confirm) instead of "unsupported". Heavy ones (diff/resume/arena/subagents/
 * editor) are compact here and get fidelity passes in M4.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRenderer, useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { SessionListItem } from '@qwen-code/qwen-code-core/services/sessionService.js';
import type { EditorType } from '@qwen-code/qwen-code-core/utils/editor.js';
import {
  allowEditorTypeInSandbox,
  checkHasEditorType,
  isEditorAvailable,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import { NO_EXEC_CONFIG } from '@qwen-code/qwen-code-core/utils/gitUtils.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import {
  EDITOR_DISPLAY_NAMES,
  editorSettingsManager,
} from '../editors/editorSettingsManager.js';
import { getScopeItems } from '../../config/dialogScopeUtils.js';
import { t } from '../../i18n/index.js';
import type { DialogListItem } from './dialogs-core.js';
import {
  DialogFrame,
  DialogSelect,
  dialogContentWidth,
  useDialogFrameKeys,
  useDialogSelect,
} from './dialogs-shared.js';
import { truncateToWidth } from '../utils/textUtils.js';
import { C } from './theme.js';
import { useGitBranchName } from '../hooks/useGitBranchName.js';
import { useDeleteCommand } from '../hooks/useDeleteCommand.js';
import { OpenTuiSessionPicker } from './session-picker.js';

function useEsc(onClose: () => void) {
  const renderer = useRenderer();
  useLayoutEffect(() => {
    const onRaw = (seq: string): boolean => {
      if (seq !== '\x1b') return false;
      onClose();
      return true;
    };
    renderer.addInputHandler(onRaw);
    return () => renderer.removeInputHandler(onRaw);
  }, [renderer, onClose]);
}

export function Shell({
  title,
  children,
  borderStyle = 'rounded',
}: {
  title: string;
  onClose?: () => void;
  children?: ReactNode;
  /** ink's AuthDialog frames itself with `borderStyle="single"`; the rest round. */
  borderStyle?: 'rounded' | 'single';
}) {
  return (
    <box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={C.borderDefault}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      marginTop={1}
      flexShrink={0}
    >
      <text fg={C.text} attributes={1}>
        {title}
      </text>
      {children}
    </box>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <box flexDirection="row">
    <box width={22}>
      <text fg={C.dim}>{label}</text>
    </box>
    <box flexGrow={1}>
      <text fg={C.text}>{value}</text>
    </box>
  </box>
);

type P = {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  /** Delete/Resume report their outcome as a command-style message. */
  notify?: (text: string, level?: 'info' | 'error') => void;
  /** Resume: sessions pre-filtered by the command (multiple title matches). */
  matchedSessions?: SessionListItem[];
  /** Resume: selection runs the real session switch (host.handleResume). */
  onSelect?: (sessionId: string) => void;
};

/**
 * ink EditorSettingsDialog parity: two-pane dialog — left a radio list of
 * available editors (unavailable ones disabled, like RadioButtonSelect over
 * editorSettingsManager displays), Tab switches to the User/Workspace scope
 * list and back; right pane shows the merged preference. Enter persists via
 * settings.setValue (useEditorSettings.handleEditorSelect guard included).
 */
export function OpenTuiEditorDialog({ settings, onClose, notify }: P) {
  const { width } = useTerminalDimensions();
  const editors = useMemo(
    () => editorSettingsManager.getAvailableEditorDisplays(),
    [],
  );
  const [mode, setMode] = useState<'editor' | 'scope'>('editor');
  const [scope, setScope] = useState<SettingScope>(SettingScope.User);
  const [error, setError] = useState<string | null>(null);
  const scopeIndexOf = (s: SettingScope) => {
    const pref = settings.forScope(s).settings.general?.preferredEditor;
    const idx = pref ? editors.findIndex((e) => e.type === pref) : 0;
    return idx >= 0 ? idx : 0;
  };

  const editorItems: Array<
    DialogListItem<EditorType | 'not_set'> & {
      label: string;
    }
  > = editors.map((e) => ({
    key: e.type,
    value: e.type,
    label: e.name,
    disabled: e.disabled,
  }));
  const editorList = useDialogSelect({
    items: editorItems,
    initialIndex: scopeIndexOf(scope),
    focused: mode === 'editor',
    numbers: mode === 'editor',
    // ink keys its editor list by the selected scope, so coming back from the
    // scope step re-seats the cursor on that scope's stored preference.
    resyncKey: scope,
    onSelect: (picked) => {
      const editorType = picked === 'not_set' ? undefined : picked;
      // useEditorSettings.handleEditorSelect's guard: an editor that is not
      // installed, or not allowed in a sandbox, is not persisted.
      if (
        editorType &&
        (!checkHasEditorType(editorType) ||
          !allowEditorTypeInSandbox(editorType))
      ) {
        return;
      }
      try {
        settings.setValue(scope, 'general.preferredEditor', editorType);
        notify?.(
          `Editor preference ${editorType ? `set to "${editorType}"` : 'cleared'} in ${scope} settings.`,
        );
      } catch (err) {
        setError(`Failed to set editor preference: ${err}`);
        return;
      }
      onClose();
    },
  });

  const scopeItems = useMemo(
    () =>
      getScopeItems().map((item) => ({
        key: item.value,
        value: item.value,
        label: t(item.label),
      })),
    [],
  );
  const initialScopeIndex = scopeItems.findIndex(
    (item) => item.value === scope,
  );
  const scopeList = useDialogSelect({
    items: scopeItems,
    initialIndex: initialScopeIndex >= 0 ? initialScopeIndex : 0,
    focused: mode === 'scope',
    numbers: mode === 'scope',
    // ink's handleScopeSelect only records the scope and steps back; the
    // editor row's Enter is what persists.
    onSelect: (next) => {
      setScope(next);
      setMode('editor');
    },
    // ink: highlighting a scope previews that scope's current preference.
    onHighlight: (next) => setScope(next),
  });

  useDialogFrameKeys({
    onTab: () => setMode((m) => (m === 'editor' ? 'scope' : 'editor')),
    onEscape: onClose,
  });

  const otherScope =
    scope === SettingScope.User ? SettingScope.Workspace : SettingScope.User;
  const otherModified =
    settings.forScope(otherScope).settings.general?.preferredEditor !==
    undefined;
  const scopeMessage = otherModified
    ? settings.forScope(scope).settings.general?.preferredEditor !== undefined
      ? `(Also modified in ${otherScope})`
      : `(Modified in ${otherScope})`
    : '';

  const merged = settings.merged.general?.preferredEditor;
  const mergedName =
    merged && isEditorAvailable(merged as EditorType)
      ? EDITOR_DISPLAY_NAMES[merged as EditorType]
      : 'None';

  // ink's left column is 45% of the dialog's content width and pads two more
  // columns, and its hint is `wrap="truncate"` inside that box, so the budget
  // is the column's own rather than the dialog's.
  const hintWidth = Math.floor(dialogContentWidth(width) * 0.45) - 2;

  return (
    <box flexDirection="column">
      {error && (
        <box marginBottom={1}>
          <text fg={C.red}>{error}</text>
        </box>
      )}
      <DialogFrame>
        <box flexDirection="row">
          <box flexDirection="column" width="45%" paddingRight={2}>
            {mode === 'editor' ? (
              <box flexDirection="column">
                <box flexDirection="row">
                  <text fg={C.text} attributes={1}>
                    {'> '}
                    {t('Select Editor')}{' '}
                  </text>
                  <text fg={C.dim}>{scopeMessage}</text>
                </box>
                <box flexDirection="column" marginTop={1}>
                  <DialogSelect
                    items={editorList.items}
                    activeIndex={editorList.activeIndex}
                    scrollOffset={editorList.scrollOffset}
                    showNumbers={mode === 'editor'}
                    focused={mode === 'editor'}
                    onHover={editorList.setActiveIndex}
                    onSelectIndex={editorList.selectIndex}
                    onWheel={(direction) =>
                      editorList.setActiveIndex(
                        editorList.activeIndexRef.current +
                          (direction === 'down' ? 1 : -1),
                      )
                    }
                    renderLabel={(item, { titleColor }) => (
                      <text fg={titleColor}>{item.label}</text>
                    )}
                  />
                </box>
              </box>
            ) : (
              <box flexDirection="column">
                <text fg={C.text} attributes={1}>
                  {'> '}
                  {t('Apply To')}
                </text>
                <box flexDirection="column" marginTop={1}>
                  <DialogSelect
                    items={scopeList.items}
                    activeIndex={scopeList.activeIndex}
                    scrollOffset={scopeList.scrollOffset}
                    showNumbers={mode === 'scope'}
                    focused={mode === 'scope'}
                    onHover={scopeList.setActiveIndex}
                    onSelectIndex={scopeList.selectIndex}
                    onWheel={(direction) =>
                      scopeList.setActiveIndex(
                        scopeList.activeIndexRef.current +
                          (direction === 'down' ? 1 : -1),
                      )
                    }
                    renderLabel={(item, { titleColor }) => (
                      <text fg={titleColor}>{item.label}</text>
                    )}
                  />
                </box>
              </box>
            )}
            <box marginTop={1}>
              <text fg={C.dim}>
                {truncateToWidth(
                  mode === 'editor'
                    ? t('(Use Enter to select, Tab to configure scope)')
                    : t('(Use Enter to apply scope, Tab to go back)'),
                  hintWidth,
                )}
              </text>
            </box>
          </box>
          <box flexDirection="column" width="55%" paddingLeft={2}>
            <text fg={C.text} attributes={1}>
              {t('Editor Preference')}
            </text>
            <box marginTop={1} flexDirection="column">
              <text fg={C.dim}>
                {t(
                  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.',
                )}
              </text>
              <box flexDirection="row" marginTop={1}>
                <text fg={C.dim}>{`${t('Your preferred editor is:')} `}</text>
                <text
                  fg={mergedName === 'None' ? C.red : C.purple}
                  attributes={1}
                >
                  {mergedName}
                </text>
                <text fg={C.dim}>{'.'}</text>
              </box>
            </box>
          </box>
        </box>
      </DialogFrame>
    </box>
  );
}

export function OpenTuiTrustDialog({ config, onClose }: P) {
  useEsc(onClose);
  const trusted = config?.isTrustedFolder?.() ?? false;
  return (
    <Shell title="Trust" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <Row label="Folder trusted:" value={trusted ? 'yes' : 'no'} />
        <text fg={C.dim}>
          {'Untrusted folders block privileged approval modes.'}
        </text>
      </box>
    </Shell>
  );
}

/**
 * Session deletion: the same picker ink's `/delete` mounts, driven by ink's own
 * `useDeleteCommand` so the single-delete guard, the batch-delete mutex and
 * every outcome message are shared rather than re-worded. The live session is
 * disabled in place instead of filtered out, matching ink.
 */
export function OpenTuiDeleteDialog({ config, onClose, notify }: P) {
  const currentBranch = useGitBranchName(config?.getTargetDir() ?? '');
  const currentSessionId = config?.getSessionId() ?? '';
  const { handleDelete, handleDeleteMany } = useDeleteCommand({
    config: config ?? null,
    addItem: (item) => {
      if ('text' in item) {
        notify?.(String(item.text), item.type === 'error' ? 'error' : 'info');
      }
      return 0;
    },
  });
  const disabledIds = useMemo(
    () => (currentSessionId ? [currentSessionId] : undefined),
    [currentSessionId],
  );
  return (
    <OpenTuiSessionPicker
      sessionService={config?.getSessionService() ?? null}
      currentBranch={currentBranch}
      title={t('Delete Session')}
      onSelect={(sessionId) => {
        onClose();
        handleDelete(sessionId);
      }}
      onCancel={onClose}
      enableMultiSelect
      onConfirmMulti={(sessionIds) => {
        onClose();
        handleDeleteMany(sessionIds);
      }}
      disabledIds={disabledIds}
    />
  );
}

/**
 * Interactive resume picker: ink mounts the same `SessionPicker` here, with the
 * command's pre-filtered list when `/resume <fuzzy-title>` matched more than one
 * session and the paginated listing otherwise.
 */
export function OpenTuiResumeDialog({
  config,
  onClose,
  matchedSessions,
  onSelect,
}: P) {
  const currentBranch = useGitBranchName(config?.getTargetDir() ?? '');
  return (
    <OpenTuiSessionPicker
      sessionService={config?.getSessionService() ?? null}
      currentBranch={currentBranch}
      initialSessions={matchedSessions}
      enablePreview
      onSelect={(sessionId) => {
        onClose();
        onSelect?.(sessionId);
      }}
      onCancel={onClose}
    />
  );
}

export function OpenTuiBranchDialog({ onClose }: P) {
  useEsc(onClose);
  return (
    <Shell title="Branch" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>
          {'Creates a fork of the current session to explore a new path.'}
        </text>
      </box>
    </Shell>
  );
}

/**
 * The real hooks switch is the top-level `disableAllHooks` setting (default
 * false = enabled); `hooks` is an event-name → hook-arrays map with no
 * `enabled` field. Runtime additionally disables hooks in bare/safe mode
 * (config.getDisableAllHooks).
 */
export function readHooksEnabled(
  config: Pick<Config, 'getDisableAllHooks'> | undefined,
  settings: LoadedSettings,
): boolean {
  return config?.getDisableAllHooks
    ? !config.getDisableAllHooks()
    : !(
        (settings.merged as { disableAllHooks?: boolean }).disableAllHooks ??
        false
      );
}

export function OpenTuiRewindDialog({ onClose }: P) {
  useEsc(onClose);
  return (
    <Shell title="Rewind" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>
          {'Checkpoints let you rewind the conversation to an earlier turn.'}
        </text>
      </box>
    </Shell>
  );
}

export function OpenTuiDiffDialog({ onClose }: P) {
  useEsc(onClose);
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    import('node:child_process')
      .then(({ execFile }) => {
        execFile(
          'git',
          [
            ...NO_EXEC_CONFIG,
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--color=never',
          ],
          { maxBuffer: 1024 * 1024 * 8 },
          (_err, stdout) => {
            if (alive)
              setLines(
                (stdout ?? '').split('\n').filter(Boolean).slice(0, 200),
              );
          },
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Shell title="Diff" onClose={onClose}>
      <scrollbox height={14} marginTop={1} stickyScroll={false}>
        {lines.length === 0 ? (
          <text fg={C.dim}>{'no working-tree changes'}</text>
        ) : (
          lines.map((l, i) => (
            <text
              key={i}
              fg={
                l.startsWith('+') ? C.green : l.startsWith('-') ? C.red : C.dim
              }
            >
              {l}
            </text>
          ))
        )}
      </scrollbox>
    </Shell>
  );
}

export function OpenTuiSubagentCreateDialog({ onClose }: P) {
  useEsc(onClose);
  return (
    <Shell title="Subagent Create" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>{'Define a new subagent (name, tools, prompt).'}</text>
      </box>
    </Shell>
  );
}

export function OpenTuiSubagentListDialog({ config, onClose }: P) {
  useEsc(onClose);
  const [rows, setRows] = useState<Array<{ name: string; desc: string }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const mgr = (
      config as unknown as {
        getSubagentManager?: () => {
          listSubagents: () => Promise<Array<Record<string, unknown>>>;
        };
      }
    )?.getSubagentManager?.();
    if (!mgr) {
      setLoading(false);
      return;
    }
    mgr
      .listSubagents()
      .then((list) => {
        if (!alive) return;
        setRows(
          (list ?? []).map((s) => ({
            name: String(s['name'] ?? '(unnamed)'),
            desc: String(s['description'] ?? ''),
          })),
        );
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [config]);
  return (
    <Shell title="Subagents" onClose={onClose}>
      <scrollbox height={12} marginTop={1} stickyScroll={false}>
        {loading ? (
          <text fg={C.dim}>{'loading subagents…'}</text>
        ) : rows.length === 0 ? (
          <text fg={C.dim}>{'no subagents configured'}</text>
        ) : (
          rows.map((r) => (
            <box key={r.name} flexDirection="row">
              <text fg={C.green}>{'• '}</text>
              <text fg={C.text}>{r.name}</text>
              <text fg={C.dim}>{`  ${r.desc}`}</text>
            </box>
          ))
        )}
      </scrollbox>
    </Shell>
  );
}
