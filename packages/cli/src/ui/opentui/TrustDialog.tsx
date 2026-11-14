/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  isWorkspaceTrusted,
  loadTrustedFolders,
  TrustLevel,
} from '../../config/trustedFolders.js';
import { relaunchApp } from '../../utils/processUtils.js';
import { MessageType } from '../types.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import {
  DialogFrame,
  DialogSelect,
  useDialogSelect,
  dialogContentWidth,
} from './dialogs-shared.js';
import { toOriginalKey } from './key-map.js';
import { C } from './theme.js';

interface Props {
  config?: Config;
  settings: LoadedSettings;
  host: OpenTuiAppHost;
  onClose: () => void;
  availableTerminalHeight?: number;
}

function readOwner({ config, settings, host }: Props) {
  if (!config || host.config !== config || host.settings !== settings)
    return null;
  return {
    config,
    settings,
    host,
    cwd: config.getWorkingDir(),
    session: config.getSessionId(),
    target: settings.workspace.path,
  };
}
type Owner = NonNullable<ReturnType<typeof readOwner>>;
function sameOwner(
  a: ReturnType<typeof readOwner>,
  b: ReturnType<typeof readOwner>,
) {
  return (
    a !== null &&
    b !== null &&
    a.config === b.config &&
    a.settings === b.settings &&
    a.host === b.host &&
    a.cwd === b.cwd &&
    a.session === b.session &&
    a.target === b.target
  );
}

export function OpenTuiTrustDialog(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = readOwner(props);
  const token = useRef({ owner: current, revoked: false, id: 0 });
  if (token.current.revoked || !sameOwner(token.current.owner, current)) {
    token.current = {
      owner: current,
      revoked: false,
      id: token.current.id + 1,
    };
  }
  const captured = token.current;
  useKeyboard((key) => {
    if (
      mounted.current &&
      !readOwner(latest.current) &&
      toOriginalKey(key).name === 'escape'
    ) {
      latest.current.onClose();
    }
  });
  const active = () => {
    if (!mounted.current || captured.revoked || token.current !== captured)
      return false;
    if (!sameOwner(captured.owner, readOwner(latest.current))) {
      captured.revoked = true;
      return false;
    }
    return true;
  };
  return current ? (
    <TrustView
      key={captured.id}
      owner={current}
      availableTerminalHeight={props.availableTerminalHeight}
      active={active}
      onClose={() => {
        if (!active()) return;
        captured.revoked = true;
        latest.current.onClose();
      }}
    />
  ) : (
    <DialogFrame>
      <text fg={C.red}>Workspace trust owner is unavailable.</text>
    </DialogFrame>
  );
}

const items = [
  {
    key: TrustLevel.TRUST_FOLDER,
    value: TrustLevel.TRUST_FOLDER,
    label: 'Trust this folder',
  },
  {
    key: TrustLevel.TRUST_PARENT,
    value: TrustLevel.TRUST_PARENT,
    label: 'Trust parent folder',
  },
  {
    key: TrustLevel.DO_NOT_TRUST,
    value: TrustLevel.DO_NOT_TRUST,
    label: "Don't trust",
  },
];

function TrustView({
  owner,
  active,
  onClose,
  availableTerminalHeight,
}: {
  owner: Owner;
  active: () => boolean;
  onClose: () => void;
  availableTerminalHeight?: number;
}) {
  const { width, height } = useTerminalDimensions();
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const revealPending = useRef(true);
  const bodyRows = Math.max(1, (availableTerminalHeight ?? height) - 4);
  const labelWidth = Math.max(1, dialogContentWidth(width) - 6);
  const [initial] = useState(() => {
    try {
      const folders = loadTrustedFolders();
      const level = folders.user.config[owner.cwd];
      const effective = isWorkspaceTrusted(
        owner.settings.merged,
        undefined,
        owner.cwd,
      );
      return { level, effective, error: '' };
    } catch (error) {
      return { level: undefined, effective: undefined, error: String(error) };
    }
  });
  const [error, setError] = useState(initial.error);
  const [pending, setPending] = useState<TrustLevel>();
  const pendingRef = useRef<TrustLevel | undefined>(undefined);
  const restarting = useRef(false);
  const [busy, setBusy] = useState(false);
  const fail = (cause: unknown) => {
    if (!active()) return;
    const message = `Could not update workspace trust: ${cause instanceof Error ? cause.message : String(cause)}`;
    setError(message);
    owner.host.addItem({ type: MessageType.ERROR, text: message }, Date.now());
  };
  const select = (level: TrustLevel) => {
    if (!active() || restarting.current || initial.error) return;
    pendingRef.current = undefined;
    setPending(undefined);
    setError('');
    try {
      const folders = loadTrustedFolders();
      const before = isWorkspaceTrusted(
        owner.settings.merged,
        undefined,
        owner.cwd,
      );
      const after = isWorkspaceTrusted(
        owner.settings.merged,
        { ...folders.user.config, [owner.cwd]: level },
        owner.cwd,
      );
      if (!active()) return;
      if (
        level === TrustLevel.DO_NOT_TRUST &&
        after.isTrusted &&
        (after.source === 'file' || after.source === 'ide')
      ) {
        owner.host.addItem(
          {
            type: MessageType.WARNING,
            text:
              after.source === 'file'
                ? 'Note: This folder is still trusted because a parent folder is trusted.'
                : 'Note: This folder is still trusted because the connected IDE workspace is trusted.',
          },
          Date.now(),
        );
      }
      if (!active()) return;
      if (before.isTrusted !== after.isTrusted) {
        pendingRef.current = level;
        setPending(level);
      } else {
        folders.setValue(owner.cwd, level);
        onClose();
      }
    } catch (cause) {
      fail(cause);
    }
  };
  const restart = () => {
    const level = pendingRef.current;
    if (!level || restarting.current || !active()) return;
    try {
      if (realpathSync(owner.cwd) !== realpathSync(process.cwd())) {
        throw new Error(
          'The selected workspace cannot restart this CLI process.',
        );
      }
      if (!active()) return;
      loadTrustedFolders().setValue(owner.cwd, level);
      if (!active()) return;
      restarting.current = true;
      setBusy(true);
      void relaunchApp().catch((cause: unknown) => {
        restarting.current = false;
        if (active()) {
          setBusy(false);
          const message = `Trust was saved, but the CLI could not restart: ${cause instanceof Error ? cause.message : String(cause)}`;
          setError(message);
          owner.host.addItem(
            { type: MessageType.ERROR, text: message },
            Date.now(),
          );
        }
      });
    } catch (cause) {
      fail(cause);
    }
  };
  useKeyboard((key) => {
    const original = toOriginalKey(key);
    if (!active() || restarting.current) return;
    if (original.name === 'pageup' || original.name === 'pagedown') {
      scroll.current?.scrollBy(
        (original.name === 'pageup' ? -1 : 1) * bodyRows,
      );
    }
    if (original.name === 'escape') onClose();
    if (original.name === 'r' && !original.ctrl && !original.meta) restart();
  });
  const selection = useDialogSelect({
    items,
    initialIndex: Math.max(
      0,
      items.findIndex((item) => item.value === initial.level),
    ),
    focused: !busy && !initial.error,
    onSelect: select,
  });
  const selectedIndex = selection.activeIndex;
  useLayoutEffect(() => {
    revealPending.current = true;
    scroll.current?.requestRender();
  }, [selectedIndex]);
  const inherited =
    initial.effective?.isTrusted &&
    (initial.effective.source === 'file' ||
      initial.effective.source === 'ide') &&
    (!initial.level || initial.level === TrustLevel.DO_NOT_TRUST);
  return (
    <DialogFrame>
      <scrollbox
        ref={(node) => {
          scroll.current = node;
        }}
        height={bodyRows}
        width="100%"
        contentOptions={{ width: '100%', paddingRight: 1 }}
        onSizeChange={() => {
          revealPending.current = true;
        }}
        renderAfter={() => {
          if (!revealPending.current) return;
          revealPending.current = false;
          scroll.current?.scrollChildIntoView(
            `trust-choice-${items[selection.activeIndexRef.current].value}`,
          );
        }}
      >
        <text fg={C.text} attributes={1}>
          {'> '}Modify Trust Level
        </text>
        <text fg={C.text}>Folder: {owner.cwd}</text>
        <text fg={C.text}>Current Level: {initial.level ?? 'Not Set'}</text>
        {inherited ? (
          <text fg={C.dim}>
            {initial.effective?.source === 'ide'
              ? 'Note: This folder behaves as a trusted folder because the connected IDE workspace is trusted. It will remain trusted even if you set a different trust level here.'
              : 'Note: This folder currently inherits trust from a parent folder. A more-specific trust rule here can override that decision.'}
          </text>
        ) : null}
        <DialogSelect
          {...selection}
          focused={!busy && !initial.error}
          onHover={selection.highlightIndex}
          onWheel={(direction) =>
            selection.setActiveIndex(
              (selection.activeIndexRef.current +
                (direction === 'up' ? -1 : 1) +
                items.length) %
                items.length,
            )
          }
          onSelectIndex={selection.selectIndex}
          renderLabel={(item) => (
            <text id={`trust-choice-${item.value}`} width={labelWidth}>
              {item.label}
            </text>
          )}
        />
        <text fg={C.dim}>(Use Enter to select; Esc to close)</text>
        {pending ? (
          <text fg={C.yellow}>
            To apply the trust changes, Qwen Code must be restarted. Press
            &apos;r&apos; to restart CLI now.
          </text>
        ) : null}
        {error ? <text fg={C.red}>{error}</text> : null}
      </scrollbox>
    </DialogFrame>
  );
}
