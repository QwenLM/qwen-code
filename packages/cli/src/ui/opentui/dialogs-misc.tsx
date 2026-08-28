/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compact native OpenTUI dialogs for the remaining long-tail commands
 * (M3, #8677): editor/auth/trust/delete/resume/branch/hooks/rewind/diff/
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
import { useRenderer, useKeyboard } from '@opentui/react';
import type {
  Config,
  EditorType,
  SessionListItem,
} from '@qwen-code/qwen-code-core';
import {
  allowEditorTypeInSandbox,
  checkHasEditorType,
  isEditorAvailable,
} from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import {
  EDITOR_DISPLAY_NAMES,
  editorSettingsManager,
} from '../editors/editorSettingsManager.js';
import { getScopeItems } from '../../config/dialogScopeUtils.js';
import { toOriginalKey } from './key-map.js';
import { fireSessionDeleteHook } from '../../hooks/session-delete-hook.js';
import { C } from './theme.js';

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
}: {
  title: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <box
      flexDirection="column"
      border
      borderColor={C.dim}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      marginTop={1}
      flexShrink={0}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={C.accent} attributes={1}>
          {title}
        </text>
        <text fg={C.dim}>{'esc to close'}</text>
      </box>
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
  notify?: (text: string) => void;
  /** Resume: sessions pre-filtered by the command (multiple title matches). */
  matchedSessions?: SessionListItem[];
  /** Resume: selection runs the real session switch (host.handleResume). */
  onSelect?: (sessionId: string) => void;
};

/**
 * ink BaseSelectionList navigation parity: arrow keys clamp at the edges and
 * skip disabled entries (keeps walking in the same direction; stays put when
 * no enabled entry remains in that direction).
 */
export function nextEnabledIndex(
  items: ReadonlyArray<{ disabled?: boolean }>,
  current: number,
  delta: 1 | -1,
): number {
  let next = current;
  for (let i = 0; i < items.length; i++) {
    next = Math.min(items.length - 1, Math.max(0, next + delta));
    if (!items[next]?.disabled) return next;
    if (next === 0 || next === items.length - 1) break;
  }
  return current;
}

/**
 * ink EditorSettingsDialog parity: two-pane dialog — left a radio list of
 * available editors (unavailable ones disabled, like RadioButtonSelect over
 * editorSettingsManager displays), Tab switches to the User/Workspace scope
 * list and back; right pane shows the merged preference. Enter persists via
 * settings.setValue (useEditorSettings.handleEditorSelect guard included).
 */
export function OpenTuiEditorDialog({ settings, onClose, notify }: P) {
  useEsc(onClose);
  const editors = useMemo(
    () => editorSettingsManager.getAvailableEditorDisplays(),
    [],
  );
  const [mode, setMode] = useState<'editor' | 'scope'>('editor');
  const [scope, setScope] = useState<SettingScope>(SettingScope.User);
  const scopeIndexOf = (s: SettingScope) => {
    const pref = settings.forScope(s).settings.general?.preferredEditor;
    const idx = pref ? editors.findIndex((e) => e.type === pref) : 0;
    return idx >= 0 ? idx : 0;
  };
  const [sel, setSel] = useState(() => scopeIndexOf(SettingScope.User));
  const scopeItems = useMemo(() => getScopeItems(), []);
  const [scopeSel, setScopeSel] = useState(0);

  // ink: highlighting a scope previews that scope's current preference.
  const highlightScope = (idx: number) => {
    const item = scopeItems[idx];
    if (!item) return;
    setScope(item.value);
  };
  const applyScope = () => {
    const item = scopeItems[scopeSel];
    if (!item) return;
    setScope(item.value);
    setSel(scopeIndexOf(item.value));
    setMode('editor');
  };

  const moveEditor = (d: 1 | -1) =>
    setSel((s) => nextEnabledIndex(editors, s, d));

  const pick = () => {
    const item = editors[sel];
    if (!item || item.disabled) return;
    const editorType = item.type === 'not_set' ? undefined : item.type;
    if (
      editorType &&
      (!checkHasEditorType(editorType) || !allowEditorTypeInSandbox(editorType))
    ) {
      return;
    }
    try {
      settings.setValue(scope, 'general.preferredEditor', editorType);
      notify?.(
        `Editor preference ${editorType ? `set to "${editorType}"` : 'cleared'} in ${scope} settings.`,
      );
    } catch {
      return;
    }
    onClose();
  };

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'tab') {
      setMode((m) => (m === 'editor' ? 'scope' : 'editor'));
    } else if (o.name === 'up' || o.name === 'down') {
      const d = o.name === 'up' ? -1 : 1;
      if (mode === 'editor') {
        moveEditor(d);
      } else {
        const next = Math.min(scopeItems.length - 1, Math.max(0, scopeSel + d));
        setScopeSel(next);
        highlightScope(next);
      }
    } else if (o.name === 'return') {
      if (mode === 'editor') pick();
      else applyScope();
    }
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

  return (
    <Shell title="Editor" onClose={onClose}>
      <box flexDirection="row" marginTop={1}>
        <box flexDirection="column" width="45%" paddingRight={2}>
          {mode === 'editor' ? (
            <box flexDirection="column">
              <box flexDirection="row">
                <text fg={C.text} attributes={1}>
                  {'> Select Editor '}
                </text>
                <text fg={C.dim}>{scopeMessage}</text>
              </box>
              <box flexDirection="column" marginTop={1}>
                {editors.map((e, i) => (
                  <box key={e.type} flexDirection="row">
                    <text fg={i === sel ? C.accent : C.dim}>
                      {i === sel ? '● ' : '○ '}
                    </text>
                    <text
                      fg={e.disabled ? C.dim : i === sel ? C.text : C.dim}
                      attributes={!e.disabled && i === sel ? 1 : 0}
                    >
                      {e.name}
                    </text>
                  </box>
                ))}
              </box>
            </box>
          ) : (
            <box flexDirection="column">
              <text fg={C.text} attributes={1}>
                {'> Apply To'}
              </text>
              <box flexDirection="column" marginTop={1}>
                {scopeItems.map((s, i) => (
                  <box key={s.value} flexDirection="row">
                    <text fg={i === scopeSel ? C.accent : C.dim}>
                      {i === scopeSel ? '● ' : '○ '}
                    </text>
                    <text fg={i === scopeSel ? C.text : C.dim}>{s.label}</text>
                  </box>
                ))}
              </box>
            </box>
          )}
          <box marginTop={1}>
            <text fg={C.dim}>
              {mode === 'editor'
                ? '(Use Enter to select, Tab to configure scope)'
                : '(Use Enter to apply scope, Tab to go back)'}
            </text>
          </box>
        </box>
        <box flexDirection="column" width="55%" paddingLeft={2}>
          <text fg={C.text} attributes={1}>
            {'Editor Preference'}
          </text>
          <box marginTop={1} flexDirection="column">
            <text fg={C.dim}>
              {
                'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.'
              }
            </text>
            <box flexDirection="row">
              <text fg={C.dim}>{'Your preferred editor is: '}</text>
              <text
                fg={mergedName === 'None' ? C.red : C.accent}
                attributes={1}
              >
                {mergedName}
              </text>
              <text fg={C.dim}>{'.'}</text>
            </box>
          </box>
        </box>
      </box>
    </Shell>
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
 * Real session deletion (audit 01 G-10): a session picker over
 * `SessionService.listSessions` (the current session is disabled, ink
 * parity) whose Enter runs `removeSession` + the SessionDelete hook —
 * the same services ink's useDeleteCommand drives.
 */
export function OpenTuiDeleteDialog({ config, onClose, notify }: P) {
  useEsc(onClose);
  const [rows, setRows] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const currentSessionId = config?.getSessionId?.() ?? '';
  useEffect(() => {
    let alive = true;
    const svc = config?.getSessionService?.();
    if (!svc) {
      setLoading(false);
      return;
    }
    svc
      .listSessions({ size: 20 })
      .then((res) => {
        if (!alive) return;
        setRows(res.items ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [config]);
  const isDisabled = (row: SessionListItem) =>
    row.sessionId === currentSessionId;
  const move = (dir: 1 | -1) => {
    setCursor((prev) => {
      let next = prev;
      for (let i = 0; i < rows.length; i++) {
        next = (next + dir + rows.length) % rows.length;
        const row = rows[next];
        if (row && !isDisabled(row)) return next;
      }
      return prev;
    });
  };
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (busy || loading) return;
    if (o.name === 'up') {
      move(-1);
      return;
    }
    if (o.name === 'down') {
      move(1);
      return;
    }
    if (o.name === 'return') {
      const row = rows[cursor];
      if (!row || isDisabled(row) || !config) return;
      setBusy(true);
      const svc = config.getSessionService();
      void svc
        .removeSession(row.sessionId)
        .then((success) => {
          if (success) {
            fireSessionDeleteHook(config, row.sessionId);
            notify?.('Session deleted successfully.');
          } else {
            notify?.('Failed to delete session. Session not found.');
          }
          onClose();
        })
        .catch(() => {
          notify?.('Failed to delete session.');
          setBusy(false);
        });
    }
  });
  return (
    <Shell title="Delete Session" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>
          {'Select a session to delete · enter to delete · esc to cancel'}
        </text>
        <scrollbox height={12} marginTop={1} stickyScroll={false}>
          {loading ? (
            <text fg={C.dim}>{'loading sessions…'}</text>
          ) : rows.length === 0 ? (
            <text fg={C.dim}>{'no previous sessions'}</text>
          ) : (
            rows.map((r, i) => {
              const disabled = isDisabled(r);
              const selected = i === cursor;
              const title = r.customTitle || r.prompt || '(untitled)';
              return (
                <box key={r.sessionId} flexDirection="row">
                  <text fg={selected ? C.accent : C.dim}>
                    {selected ? '› ' : '  '}
                  </text>
                  <text fg={disabled ? C.dim : selected ? C.accent : C.text}>
                    {title.length > 40 ? `${title.slice(0, 40)}…` : title}
                  </text>
                  <text fg={C.dim}>{`  ${r.sessionId.slice(0, 8)}${
                    disabled ? ' (current)' : ''
                  }`}</text>
                </box>
              );
            })
          )}
        </scrollbox>
        {busy && <text fg={C.dim}>{'deleting…'}</text>}
      </box>
    </Shell>
  );
}

/**
 * Interactive resume picker (audit 01 G-5 / 05 G-04): ↑↓ navigation + Enter
 * selects, running the real session switch through `onSelect`
 * (host.handleResume). `matchedSessions` is the command's pre-filtered list
 * (`/resume <fuzzy-title>` with multiple matches); without it the 10 most
 * recent sessions are listed, like ink's SessionPicker default.
 */
export function OpenTuiResumeDialog({
  config,
  onClose,
  matchedSessions,
  onSelect,
}: P) {
  useEsc(onClose);
  const [rows, setRows] = useState<SessionListItem[]>(matchedSessions ?? []);
  const [loading, setLoading] = useState(!matchedSessions);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (matchedSessions) {
      setRows(matchedSessions);
      setLoading(false);
      return;
    }
    let alive = true;
    const svc = config?.getSessionService?.();
    if (!svc) {
      setLoading(false);
      return;
    }
    svc
      .listSessions({ size: 10 })
      .then((res) => {
        if (!alive) return;
        setRows(res.items ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [config, matchedSessions]);
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (loading) return;
    if (o.name === 'up') {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (o.name === 'down') {
      setCursor((prev) => Math.min(rows.length - 1, prev + 1));
      return;
    }
    if (o.name === 'return') {
      const row = rows[cursor];
      if (!row) return;
      onClose();
      onSelect?.(row.sessionId);
    }
  });
  return (
    <Shell title="Resume" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>
          {'↑↓ to navigate · enter to resume · esc to cancel'}
        </text>
        <scrollbox height={12} marginTop={1} stickyScroll={false}>
          {loading ? (
            <text fg={C.dim}>{'loading sessions…'}</text>
          ) : rows.length === 0 ? (
            <text fg={C.dim}>{'no previous sessions'}</text>
          ) : (
            rows.map((r, i) => {
              const selected = i === cursor;
              const title = r.customTitle || r.prompt || '(untitled)';
              const when = r.startTime ? r.startTime.slice(0, 10) : '';
              return (
                <box key={r.sessionId} flexDirection="row">
                  <text fg={selected ? C.accent : C.dim}>
                    {selected ? '› ' : '  '}
                  </text>
                  <text fg={selected ? C.accent : C.text}>
                    {title.length > 40 ? `${title.slice(0, 40)}…` : title}
                  </text>
                  <text fg={C.dim}>{`  ${r.sessionId.slice(0, 8)}${
                    when ? ` · ${when}` : ''
                  }`}</text>
                </box>
              );
            })
          )}
        </scrollbox>
      </box>
    </Shell>
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

export function OpenTuiHooksDialog({ config, settings, onClose }: P) {
  useEsc(onClose);
  const enabled = readHooksEnabled(config, settings);
  return (
    <Shell title="Hooks" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <Row label="Hooks enabled:" value={enabled ? 'yes' : 'no'} />
        <text fg={C.dim}>
          {'Lifecycle hooks run around tool/session events.'}
        </text>
      </box>
    </Shell>
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
          ['diff', '--color=never'],
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
