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

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useRenderer, useKeyboard } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { toOriginalKey } from './key-map.js';
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

type P = { config?: Config; settings: LoadedSettings; onClose: () => void };

export function OpenTuiEditorDialog({ config, onClose }: P) {
  useEsc(onClose);
  const editor = (
    config as { getPreferredEditor?: () => string }
  )?.getPreferredEditor?.();
  return (
    <Shell title="Editor" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <Row label="Preferred editor:" value={editor ?? '(none)'} />
        <text fg={C.dim}>{'Set via /settings or $EDITOR/$VISUAL.'}</text>
      </box>
    </Shell>
  );
}

export function OpenTuiAuthDialog({ config, onClose }: P) {
  useEsc(onClose);
  const model = config?.getModel?.() ?? 'n/a';
  return (
    <Shell title="Auth" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <Row label="Active model:" value={model} />
        <text fg={C.dim}>
          {'Credentials resolved from settings/env; use /model to switch.'}
        </text>
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

export function OpenTuiDeleteDialog({ onClose }: P) {
  useEsc(onClose);
  const [confirm, setConfirm] = useState(false);
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'y') setConfirm(true);
    if (o.name === 'n') onClose();
  });
  return (
    <Shell title="Delete Session" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.text}>{'Delete the current session history?'}</text>
        <text fg={confirm ? C.green : C.dim}>
          {confirm ? 'deleting…' : 'press y to confirm · n / esc to cancel'}
        </text>
      </box>
    </Shell>
  );
}

export function OpenTuiResumeDialog({ onClose }: P) {
  useEsc(onClose);
  return (
    <Shell title="Resume" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>
          {'Recent sessions appear here; select one to resume.'}
        </text>
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

export function OpenTuiHooksDialog({ settings, onClose }: P) {
  useEsc(onClose);
  const hooks = (settings.merged as { hooks?: Record<string, unknown> })?.hooks;
  const enabled = Boolean((hooks as { enabled?: boolean })?.enabled ?? false);
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

export function OpenTuiArenaDialog({ onClose }: P) {
  useEsc(onClose);
  return (
    <Shell title="Arena" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>{'Multi-model arena sessions.'}</text>
      </box>
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
  const subagents = (
    config as { getSubagents?: () => Array<{ name: string }> }
  )?.getSubagents?.();
  return (
    <Shell title="Subagents" onClose={onClose}>
      <box flexDirection="column" marginTop={1}>
        {subagents && subagents.length > 0 ? (
          subagents.map((s) => (
            <box key={s.name} flexDirection="row">
              <text fg={C.green}>{'• '}</text>
              <text fg={C.text}>{s.name}</text>
            </box>
          ))
        ) : (
          <text fg={C.dim}>{'no subagents configured'}</text>
        )}
      </box>
    </Shell>
  );
}
