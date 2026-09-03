/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native OpenTUI ApprovalMode and Effort dialogs (parity follow-up to #8677),
 * ported from ink ApprovalModeDialog/EffortDialog: a radio list navigated with
 * up/down, Enter applies (settings + config), Esc cancels.
 */

import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useRenderer, useKeyboard } from '@opentui/react';
import { APPROVAL_MODES } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { BUILT_IN_OUTPUT_STYLES } from '@qwen-code/qwen-code-core/core/output-styles.js';
import type { OutputStyleDefinition } from '@qwen-code/qwen-code-core/core/output-styles.js';
import {
  applyReasoningEffort,
  REASONING_EFFORT_TIERS,
} from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import type { ReasoningEffort } from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { applyOutputStyleSelection } from '../commands/output-style-utils.js';
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

function RadioList({
  items,
  selected,
  onMove,
  onPick,
}: {
  items: Array<{ key: string; label: string; desc?: string }>;
  selected: number;
  onMove: (d: 1 | -1) => void;
  onPick: () => void;
}) {
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'up') onMove(-1);
    else if (o.name === 'down') onMove(1);
    else if (o.name === 'return') onPick();
  });
  return (
    <box flexDirection="column" marginTop={1}>
      {items.map((it, i) => (
        <box key={it.key} flexDirection="row">
          <text fg={i === selected ? C.accent : C.dim}>
            {i === selected ? '● ' : '○ '}
          </text>
          <text
            fg={i === selected ? C.text : C.dim}
            attributes={i === selected ? 1 : 0}
          >
            {it.label}
          </text>
          {it.desc ? <text fg={C.dim}>{`  ${it.desc}`}</text> : null}
        </box>
      ))}
    </box>
  );
}

const Shell = ({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
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
      <text fg={C.dim}>{'↑↓ · enter · esc'}</text>
    </box>
    {children}
  </box>
);

const MODE_DESC: Record<string, string> = {
  default: 'Prompt for each tool',
  'auto-edit': 'Auto-approve edits',
  auto: 'Full auto, safer rules',
  yolo: 'Auto-approve everything',
  plan: 'Plan only, no execution',
};

export function OpenTuiApprovalModeDialog(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  onApprovalModeChanged: (m: ApprovalMode) => void;
}) {
  const { config, settings, onClose, onApprovalModeChanged } = props;
  const modes = APPROVAL_MODES as ApprovalMode[];
  const current = config?.getApprovalMode?.();
  const [sel, setSel] = useState(
    Math.max(0, modes.indexOf(current as ApprovalMode)),
  );
  useEsc(onClose);
  const pick = () => {
    const mode = modes[sel];
    if (mode) {
      try {
        // ink defaults the persist scope to User (its scope picker) — an
        // untrusted workspace never receives writes; the runtime applies the
        // merged setting (useApprovalModeCommand parity).
        settings.setValue(SettingScope.User, 'tools.approvalMode', mode);
        config?.setApprovalMode?.(settings.merged.tools?.approvalMode ?? mode);
        onApprovalModeChanged(mode);
      } catch {
        /* trust gate */
      }
    }
    onClose();
  };
  return (
    <Shell title="Approval Mode">
      <RadioList
        items={modes.map((m) => ({
          key: m,
          label: String(m),
          desc: MODE_DESC[String(m)],
        }))}
        selected={sel}
        onMove={(d) =>
          setSel((s) => Math.min(modes.length - 1, Math.max(0, s + d)))
        }
        onPick={pick}
      />
    </Shell>
  );
}

const EFFORT_DESC: Record<string, string> = {
  low: 'Fastest and cheapest',
  medium: 'Balanced speed/cost',
  high: 'Default strong reasoning',
  xhigh: 'Extended agentic reasoning',
  max: 'Maximum reasoning',
};

export function OpenTuiEffortDialog(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
}) {
  const { config, settings, onClose } = props;
  const tiers = REASONING_EFFORT_TIERS as ReasoningEffort[];
  // Pre-select the live tier only when one is configured; an unset effort
  // starts at the top (ink EffortDialog initialIndex parity).
  const currentEffort = config?.getReasoningEffort?.();
  const [sel, setSel] = useState(
    currentEffort ? Math.max(0, tiers.indexOf(currentEffort)) : 0,
  );
  useEsc(onClose);
  const pick = () => {
    const effort = tiers[sel];
    if (effort) {
      try {
        // Apply at runtime (next turn) and persist for future sessions;
        // provider adapters clamp the tier per model (ink useEffortCommand
        // parity — the request pipeline reads the live config per request).
        if (config) {
          applyReasoningEffort(config, effort);
        }
        settings.setValue(
          getPersistScopeForModelSelection(settings),
          'model.reasoningEffort',
          effort,
        );
      } catch {
        /* ignore */
      }
    }
    onClose();
  };
  return (
    <Shell title="Reasoning Effort">
      <RadioList
        items={tiers.map((t) => ({
          key: t,
          label: String(t),
          desc: EFFORT_DESC[String(t)],
        }))}
        selected={sel}
        onMove={(d) =>
          setSel((s) => Math.min(tiers.length - 1, Math.max(0, s + d)))
        }
        onPick={pick}
      />
    </Shell>
  );
}

const DEFAULT_STYLE_DESC = 'The standard prompt, with no extra style';

export function OpenTuiOutputStyleDialog(props: {
  config: Config;
  settings: LoadedSettings;
  onClose: () => void;
  notify: (text: string) => void;
}) {
  const { config, settings, onClose, notify } = props;
  const items: Array<{
    key: string;
    label: string;
    desc: string;
    style: OutputStyleDefinition | undefined;
  }> = [
    {
      key: 'default',
      label: 'default',
      desc: DEFAULT_STYLE_DESC,
      style: undefined,
    },
    ...BUILT_IN_OUTPUT_STYLES.map((style) => ({
      key: style.name,
      label: style.name,
      desc: style.description,
      style,
    })),
  ];
  // Unlike /effort, "no style configured" genuinely is the first entry
  // (default), so pre-selecting index 0 in that case tells the truth (ink
  // OutputStyleDialog parity).
  const current = config.getOutputStyle()?.name;
  const [sel, setSel] = useState(
    Math.max(
      0,
      items.findIndex((item) => item.key === current),
    ),
  );
  useEsc(onClose);
  const pick = () => {
    const item = items[sel];
    if (!item) return;
    // Close first, like ink's handleOutputStyleSelect: the apply rebuilds
    // the system instruction, and the dialog should not sit open for it.
    onClose();
    void applyOutputStyleSelection(config, settings, item.style).then(
      (message) => notify(message),
      (error: unknown) =>
        notify(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <Shell title="Output Style">
      <RadioList
        items={items}
        selected={sel}
        onMove={(d) =>
          setSel((s) => Math.min(items.length - 1, Math.max(0, s + d)))
        }
        onPick={pick}
      />
    </Shell>
  );
}
