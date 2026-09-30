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
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { getAllGeminiMdFilenames } from '@qwen-code/qwen-code-core/utils/memory-constants.js';
import type { LoadedSettings } from '../../config/settings.js';
import { STATUS_LINE_PRESET_ITEMS } from '../statusLinePresets.js';
import { C } from './theme.js';

/**
 * Parity of MemoryDialog.resolvePreferredMemoryFile: the first configured
 * context filename that exists in `dir`, else the configured primary
 * filename (the file the editor would create).
 */
export function resolvePreferredMemoryFile(dir: string): string {
  const filenames = getAllGeminiMdFilenames();
  for (const filename of filenames) {
    const filePath = path.join(dir, filename);
    try {
      if (fs.existsSync(filePath)) return filePath;
    } catch {
      // Unreadable — try the next candidate.
    }
  }
  return path.join(dir, filenames[0] ?? 'QWEN.md');
}

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

/**
 * ink MemoryDialog readToggle parity: managed-memory toggles default ON,
 * and bare/safe modes gate every one of them off (runtime gates the config
 * getters on !getBareMode() && !isSafeMode()).
 */
export function readMemoryToggle(
  value: unknown,
  modes: { bareMode: boolean; safeMode: boolean },
): boolean {
  return !modes.bareMode && !modes.safeMode && Boolean(value ?? true);
}

export function OpenTuiMemoryDialog(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
}) {
  const { config, settings, onClose } = props;
  useEsc(onClose);
  const mem = (settings.merged as { memory?: Record<string, unknown> })?.memory;
  const modes = {
    bareMode: config?.getBareMode?.() ?? false,
    safeMode: config?.isSafeMode?.() ?? false,
  };
  const toggle = (k: string) => readMemoryToggle(mem?.[k], modes);
  // Real memory file names (audit 01 G-8): ink's MemoryDialog resolves the
  // user file from Storage.getGlobalQwenDir() and the project file from the
  // working dir, both through getAllGeminiMdFilenames() (default QWEN.md) —
  // never a hardcoded memory.md.
  const cwd = config?.getWorkingDir?.() ?? process.cwd();
  const filenames = getAllGeminiMdFilenames();
  const userMem = path.join(
    Storage.getGlobalQwenDir(),
    filenames[0] ?? 'QWEN.md',
  );
  const projectMem = resolvePreferredMemoryFile(cwd);
  return (
    <Shell title="Memory">
      <box flexDirection="column" marginTop={1}>
        <Row label="User memory:" value={userMem} />
        <Row label="Project memory:" value={projectMem} />
        {filenames.length > 1 && (
          <Row label="Context files:" value={filenames.join(', ')} />
        )}
        <Row
          label="Managed auto-memory:"
          value={toggle('enableManagedAutoMemory') ? 'on' : 'off'}
        />
        <Row
          label="Auto-dream:"
          value={toggle('enableManagedAutoDream') ? 'on' : 'off'}
        />
        <Row
          label="Auto-skill:"
          value={toggle('enableAutoSkill') ? 'on' : 'off'}
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
