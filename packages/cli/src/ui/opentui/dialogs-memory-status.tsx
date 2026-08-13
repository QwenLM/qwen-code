/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compact native OpenTUI Memory and StatusLine dialogs (M3 long-tail, #8677).
 * Faithful-enough display ports: Memory lists the user/project memory sources
 * + toggles from settings; StatusLine lists the preset items. Esc closes.
 */

import { useLayoutEffect } from 'react';
import { useRenderer } from '@opentui/react';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { STATUS_LINE_PRESET_ITEMS } from '../statusLinePresets.js';
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

const Shell = ({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) => (
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

const Row = ({ label, value }: { label: string; value: string }) => (
  <box flexDirection="row">
    <box width={24}>
      <text fg={C.dim}>{label}</text>
    </box>
    <box flexGrow={1}>
      <text fg={C.text}>{value}</text>
    </box>
  </box>
);

export function OpenTuiMemoryDialog(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
}) {
  const { config, settings, onClose } = props;
  useEsc(onClose);
  const mem = (settings.merged as { memory?: Record<string, unknown> })?.memory;
  const toggle = (k: string, dflt: boolean) => Boolean(mem?.[k] ?? dflt);
  const cwd = config?.getWorkingDir?.() ?? process.cwd();
  const userMem = path.join(os.homedir(), '.qwen', 'memory.md');
  const projectMem = path.join(cwd, '.qwen', 'memory.md');
  return (
    <Shell title="Memory">
      <box flexDirection="column" marginTop={1}>
        <Row label="User memory:" value={userMem} />
        <Row label="Project memory:" value={projectMem} />
        <Row
          label="Managed auto-memory:"
          value={toggle('enableManagedAutoMemory', false) ? 'on' : 'off'}
        />
        <Row
          label="Auto-dream:"
          value={toggle('enableManagedAutoDream', false) ? 'on' : 'off'}
        />
        <Row
          label="Auto-skill:"
          value={toggle('enableAutoSkill', false) ? 'on' : 'off'}
        />
      </box>
    </Shell>
  );
}

export function OpenTuiStatusLineDialog(props: {
  settings: LoadedSettings;
  onClose: () => void;
}) {
  const { onClose } = props;
  useEsc(onClose);
  return (
    <Shell title="Status Line">
      <box flexDirection="column" marginTop={1}>
        <text fg={C.dim}>{'Preset items:'}</text>
        {STATUS_LINE_PRESET_ITEMS.map((it) => (
          <box key={it.id} flexDirection="row">
            <text fg={C.green}>{'• '}</text>
            <text fg={C.text}>{it.label}</text>
          </box>
        ))}
      </box>
    </Shell>
  );
}
