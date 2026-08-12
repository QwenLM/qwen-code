/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal OpenTUI-native Stats and Skills dialogs so `/stats` and `/skills`
 * open a real panel instead of an empty frame (parity follow-up to #8677).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import { C } from './theme.js';

function DialogShell({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <box
      flexDirection="column"
      border
      borderColor={C.dim}
      paddingLeft={1}
      paddingRight={1}
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

export function OpenTuiStatsDialog(props: {
  config: Config | null | undefined;
  onClose: () => void;
}) {
  const config = props.config;
  const sessionId = config?.getSessionId?.() ?? 'n/a';
  const model = config?.getModel?.() ?? 'n/a';
  const mode = config?.getApprovalMode?.() ?? 'default';
  return (
    <DialogShell title="Stats">
      <box flexDirection="column" marginTop={1}>
        <box flexDirection="row">
          <text fg={C.dim}>{'Session ID:  '}</text>
          <text fg={C.text}>{sessionId}</text>
        </box>
        <box flexDirection="row">
          <text fg={C.dim}>{'Model:       '}</text>
          <text fg={C.text}>{model}</text>
        </box>
        <box flexDirection="row">
          <text fg={C.dim}>{'Mode:        '}</text>
          <text fg={C.text}>{String(mode)}</text>
        </box>
      </box>
    </DialogShell>
  );
}

interface SkillRow {
  name: string;
  description: string;
}

export function OpenTuiSkillsDialog(props: {
  config: Config | null | undefined;
  onClose: () => void;
}) {
  const config = props.config;
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const mgr = config?.getSkillManager?.();
    if (!mgr) {
      setLoading(false);
      return;
    }
    mgr
      .listSkills()
      .then((skills) => {
        if (!alive) return;
        setRows(
          (skills as Array<{ name: string; description?: string }>).map(
            (s) => ({ name: s.name, description: s.description ?? '' }),
          ),
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
    <DialogShell title="Skills">
      <scrollbox height={12} marginTop={1} stickyScroll={false}>
        {loading ? (
          <text fg={C.dim}>{'loading skills…'}</text>
        ) : rows.length === 0 ? (
          <text fg={C.dim}>{'no skills available'}</text>
        ) : (
          rows.map((r) => (
            <box key={r.name} flexDirection="row">
              <text fg={C.green} attributes={1}>
                {r.name}
              </text>
              <text fg={C.dim}>{`  ${r.description}`}</text>
            </box>
          ))
        )}
      </scrollbox>
    </DialogShell>
  );
}
