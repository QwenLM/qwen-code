/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Folder-trust startup gate (#56): OpenTUI port of the ink useFolderTrust
 * hook + FolderTrustDialog pair. The ink hook imports FolderTrustChoice from
 * the ink component file, so reusing it would drag ink into the opentui
 * graph — the logic is inlined here, keyed directly on TrustLevel.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRenderer } from '@opentui/react';
import * as process from 'node:process';
import * as path from 'node:path';
import type { LoadedSettings } from '../../config/settings.js';
import {
  loadTrustedFolders,
  TrustLevel,
  isWorkspaceTrusted,
} from '../../config/trustedFolders.js';
import { relaunchApp } from '../../utils/processUtils.js';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import { C } from './theme.js';
import {
  DialogFrame,
  DialogSelect,
  useDialogSelect,
  type DialogListItem,
} from './dialogs-shared.js';

type TrustOption = DialogListItem<TrustLevel> & { label: string };

export function OpenTuiFolderTrustGate({
  settings,
  onOpenChange,
}: {
  settings: LoadedSettings;
  /** Reports the gate state so the backend can suppress the composer. */
  onOpenChange?: (open: boolean) => void;
}) {
  const renderer = useRenderer();
  const [isTrusted, setIsTrusted] = useState<boolean | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  // useFolderTrust mount effect parity: with folder trust disabled,
  // isWorkspaceTrusted resolves to true, so the gate only opens for an
  // undecided (undefined) workspace.
  useEffect(() => {
    const { isTrusted: trusted } = isWorkspaceTrusted(settings.merged);
    setIsTrusted(trusted);
    setOpen(trusted === undefined);
  }, [settings.merged]);

  // Change notifications only: the backend starts with the gate closed, so
  // the initial render (still undecided) reports nothing and the first
  // meaningful callback is the post-evaluation state.
  const lastReportedOpenRef = useRef(false);
  useEffect(() => {
    if (lastReportedOpenRef.current === open) return;
    lastReportedOpenRef.current = open;
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const items = useMemo<TrustOption[]>(() => {
    const dirName = path.basename(process.cwd());
    const parentFolder = path.basename(path.dirname(process.cwd()));
    return [
      {
        key: 'trust-folder',
        value: TrustLevel.TRUST_FOLDER,
        label: `Trust folder (${dirName})`,
      },
      {
        key: 'trust-parent',
        value: TrustLevel.TRUST_PARENT,
        label: `Trust parent folder (${parentFolder})`,
      },
      {
        key: 'do-not-trust',
        value: TrustLevel.DO_NOT_TRUST,
        label: "Don't trust (esc)",
      },
    ];
  }, []);

  // useFolderTrust.handleFolderTrustSelect parity (FolderTrustChoice maps 1:1
  // onto TrustLevel): persist the decision, then either close the gate or
  // flip into the restart flow. A first run treats the workspace as trusted
  // (isTrusted ?? true), so only a "don't trust" answer relaunches.
  const select = useCallback(
    (choice: TrustLevel) => {
      const trustedFolders = loadTrustedFolders();
      const cwd = process.cwd();
      const wasTrusted = isTrusted ?? true;
      try {
        trustedFolders.setValue(cwd, choice);
      } catch (error) {
        writeStderrLineSafe('Error saving trusted folders file.');
        writeStderrLineSafe(
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const currentIsTrusted =
        choice === TrustLevel.TRUST_FOLDER ||
        choice === TrustLevel.TRUST_PARENT;
      setIsTrusted(currentIsTrusted);
      if (wasTrusted !== currentIsTrusted) {
        setIsRestarting(true);
      } else {
        setOpen(false);
      }
    },
    [isTrusted],
  );

  // FolderTrustDialog relaunch parity: 250ms grace, then exit with the
  // relaunch code so the parent respawns the CLI under the new trust level.
  useEffect(() => {
    if (!isRestarting) return;
    const timer = setTimeout(() => void relaunchApp(), 250);
    return () => clearTimeout(timer);
  }, [isRestarting]);

  // Esc selects DO_NOT_TRUST (ink useKeypress parity); the raw handler runs
  // before parsed-key dispatch so the list never sees the escape. Inactive
  // while restarting, like the ink dialog's isActive guard.
  useLayoutEffect(() => {
    if (!open) return;
    const onRaw = (seq: string): boolean => {
      if (seq !== '\x1b' || isRestarting) return false;
      select(TrustLevel.DO_NOT_TRUST);
      return true;
    };
    renderer.addInputHandler(onRaw);
    return () => renderer.removeInputHandler(onRaw);
  }, [renderer, open, isRestarting, select]);

  const { activeIndex, scrollOffset, selectIndex } = useDialogSelect({
    items,
    focused: open && !isRestarting,
    onSelect: select,
  });

  if (!open) return null;

  return (
    <box
      flexDirection="column"
      marginLeft={1}
      marginRight={1}
      marginTop={1}
      flexShrink={0}
    >
      <DialogFrame borderColor={C.yellow}>
        <box flexDirection="column" marginBottom={1}>
          <text fg={C.text} attributes={1}>
            {'Do you trust this folder?'}
          </text>
          <text fg={C.text}>
            {'Trusting a folder allows Qwen Code to execute commands it'}
          </text>
          <text fg={C.text}>
            {'suggests. This is a security feature to prevent accidental'}
          </text>
          <text fg={C.text}>{'execution in untrusted directories.'}</text>
        </box>
        <DialogSelect
          items={items}
          activeIndex={activeIndex}
          scrollOffset={scrollOffset}
          focused={!isRestarting}
          renderLabel={(item, { titleColor }) => (
            <text fg={titleColor}>{item.label}</text>
          )}
          onSelectIndex={(index) => {
            if (!isRestarting) selectIndex(index);
          }}
        />
      </DialogFrame>
      {isRestarting && (
        <box marginTop={1}>
          <text fg={C.yellow}>
            {'Qwen Code is restarting to apply the trust changes...'}
          </text>
        </box>
      )}
    </box>
  );
}
